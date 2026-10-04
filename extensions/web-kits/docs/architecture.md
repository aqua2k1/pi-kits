# Pi web kit architecture

`web-kits` lives in `extensions/web-kits`. Its explicit Pi manifest declares
`./index.ts` as the only extension entry point; the existing implementation and
test layout is retained without a `src` move. `/web-tools` and temporary/cache
paths remain unchanged; configuration uses the shared `pi-kits.json`.

The package owns two independent capabilities:

```text
web_search
  -> SearXNG or Codex alpha/search

web_fetch
  -> native HTTP for ordinary URLs
  -> GitHub API or shallow clone for GitHub repository URLs
  -> bounded temp file
  -> text preview and fullOutputPath
```

Search and fetch share the extension process and configuration file, but they do
not share provider routers, authentication, or network fallbacks.

## Layer map

```text
Pi host
└── index.ts
    ├── web_search tool
    ├── web_fetch tool
    └── /web-tools command

Boundary
├── config.ts       -> @pi-kits/config, web-kits.search/web-kits.fetch resolution
├── composition.ts  -> lazy search/fetch assembly
├── schema.ts       -> pure TypeBox schemas and derived output/response types
└── fetch/format.ts -> bounded preview and local path metadata

Search
├── core/            -> contracts, normalization, routing, classified errors
├── providers/searxng/
└── providers/codex/ -> Codex OAuth and alpha/search wire format

Fetch
├── fetch/router.ts          -> GitHub then native HTTP dispatch
├── fetch/http.ts            -> Node fetch, timeout and streamed body
├── fetch/content.ts         -> HTML/text decoding
├── fetch/spool.ts           -> bounded temporary result files
├── fetch/github-url.ts      -> GitHub URL parsing
├── fetch/github.ts          -> clone/API strategy
├── fetch/gh-client.ts       -> gh/git process execution
└── fetch/github-content.ts  -> local repository tree/file rendering

Shared
├── shared/http.ts     -> existing search JSON transport
├── shared/results.ts  -> search result normalization
└── shared/limits.ts   -> search, fetch and GitHub limits
```

## Fetch call chain

```text
web_fetch(url, raw)
├─ startup snapshot (readConfigSnapshot + resolveConfig)
├─ fetchWeb(request, config.fetch, runtime, signal)
│  ├─ normalizeFetchRequest()
│  └─ WebFetchRouter.fetch()
│     ├─ GitHubHandler.fetch()
│     │  ├─ parseGitHubUrl()
│     │  ├─ mode=api -> gh api
│     │  ├─ mode=auto -> repository-size probe
│     │  ├─ small repository -> CloneManager -> gh repo clone/git clone
│     │  └─ large/failing clone -> gh api
│     └─ fetchDocument()
│        ├─ Node global fetch() with Chrome-style HTTP headers
│        ├─ follow redirects
│        ├─ stream response into bounded spool
│        ├─ decodeDocument()
│        └─ saveText() -> content.txt; remove response.bin
├─ save final logical text as content.txt
├─ buildFetchOutput()
└─ return content + details + structuredContent
```

## Native HTTP

Native HTTP uses the Node global `fetch`, not a shell command. It sends a GET
request with Chrome-style HTTP headers, follows normal HTTP redirects,
checks the status, and streams the response body to a temporary file. A
response body larger than 50 MiB is cancelled. The transport remains Node's
HTTP stack; these headers do not change its TLS or HTTP/2 fingerprint.

Binary HTTP responses are rejected as unsupported, including with `raw: true`.
The body is decoded as text, JSON, XML or HTML. HTML extraction removes script,
style, noscript and template blocks, extracts the title, converts block tags to
line breaks, and decodes entities. JavaScript is never executed.

## Temporary content

A successful text operation creates:

```text
/tmp/pi-web-fetch-<random>/content.txt
```

The file contains the final logical content that corresponds to the tool result.
For ordinary HTTP, `raw: true` stores decoded response text; normal HTML fetches
store extracted text. GitHub repository handlers ignore `raw` and keep their
repository-specific text rendering.
The model receives a small inline result for short content and a preview plus
`fullOutputPath` for larger content.

For native HTTP, the raw response is first streamed through a bounded
`response.bin` and is then converted to `content.txt`; the intermediate file is
removed. GitHub-generated
text goes directly through `saveText()` to `content.txt`, without streaming a
network body into `response.bin`. Failed or cancelled operations remove the
directory. Expired spool cleanup is owned by
extension startup rather than detached from individual fetch requests.

## GitHub strategy

Supported code URLs are:

```text
https://github.com/{owner}/{repo}
https://github.com/{owner}/{repo}/blob/{ref}/{path}
https://github.com/{owner}/{repo}/tree/{ref}/{path}
```

Issue, pull request, release, action, wiki and other UI pages use native HTTP.

`mode=auto` resolves repository metadata through `gh api`. Small repositories
use a shallow, single-branch clone. Repositories known to exceed the configured
threshold are never cloned: GitHub code-content handling is API-only, with
ordinary native HTTP still available when the GitHub API cannot serve the URL.
The clone is cached under a hashed key so owner, repository and ref cannot create arbitrary
local paths. The repository path is returned as `repositoryPath`; generated
tree or file content is also saved to `content.txt`. Both API and clone paths
render roots/trees as listings (with README content for roots), and blobs as file
text. Binary files produce a textual description rather than raw binary output;
this differs from unsupported binary native HTTP responses.

The clone does not recurse into submodules, install dependencies, run hooks,
or execute repository files. A clone timeout, missing command or failed clone
for an eligible repository can fall back to API access. `mode=api` never clones.

`gh` owns GitHub authentication. The extension invokes `gh` and `git` with
argument arrays and `shell: false`; tokens are not placed in arguments.

## Machine output contract

`schema.ts` defines separate TypeBox schemas/types for legacy `SearchDetails`
and `FetchDetails` and meaningful `SearchMachineOutput` and `FetchMachineOutput`.
Machine schemas reuse the metadata properties and add content-bearing fields;
search result fields, fetch source enums and truncation types are also derived
with `Static` to avoid parallel shape drift. This is a pure helper, not an
extension entry point. Enums use Pi's `StringEnum` for provider compatibility
rather than literal unions/`anyOf`.

The formatters retain legacy details and render model-facing text, then return
machine data as `structuredContent`. `index.ts` declares the corresponding
`outputSchema`. Pi codemode's `toScriptValue()` returns only `structuredContent`,
not `content` or `details`, so machine output includes actual search summaries
and fetch text. Failures remain classified thrown errors; there is no new error
envelope. Progress updates are still text-only, with `details: undefined`.

Search machine data contains `query`, `backend`, `resultCount`, `results`
(`title`, `url`, `snippet`), `hasSummary`, optional `truncated`, and optional
`summary`. Summary text is the provider's sanitized, bounded summary (currently
limited to 4,000 UTF-8 bytes), without display-only Markdown escaping. The
legacy details retain only `hasSummary`; no summary field is added there. Counts
match returned results, including no-results and summary-only output.

Search budgets the entire serialized return object, including all text, details
and machine copies and JSON-escaped UTF-8, within 50 KiB and the existing visible
line limit. It omits results until the return fits, marking both metadata copies
as truncated. Omitted search data is not saved. If the remaining summary/query
alone cannot fit, the existing classified `invalid-response` policy applies.

Fetch machine data contains `url`, `finalUrl`, `source` (`native-http`,
`github-gh`, `github-clone`), `fullOutputPath`, and optional `title`,
`contentType`, `contentLength`, `repositoryPath`, `truncation`, `expiresAt`, plus
`text` and `isPreview`. `text` contains the decoded/rendered saved logical text
for small results, or a UTF-8-safe preview bounded to 8 KiB / 2,000 lines.
The formatter counts the full serialized return toward 50 KiB, shortening both
visible and machine previews further if JSON escaping or metadata consumes the
budget. Metadata is not silently changed; if metadata alone cannot fit, a
classified `invalid-response` is thrown.

`isPreview` is true if machine text omits saved content **or** upstream/content
limiting already capped the saved artifact. False means the returned text covers
the stored logical artifact without reported upstream truncation; it does not
mean raw bytes, complete repository coverage or a rendered browser page.
Truncation carries `totalBytes`, `outputBytes`, and optional `totalLines` and
`outputLines`. It describes upstream/stored-content limiting, not simply a
short inline preview: a preview can omit content without a `truncation` field.
`expiresAt` is a timestamp string for the spool, not the clone cache.
`fullOutputPath` points to all saved logical text, which may already be bounded;
it is never a promise that the original source was saved in full.

Both public URL fields are the same final redacted URL, never a new requested-URL
field: native HTTP supplies `response.url` after redirects (or the normalized
request URL if absent), while GitHub's `storeResponse()` supplies the handler's
request URL. The router passes that provenance through unchanged. Only the
output formatter removes credentials/fragments and redacts sensitive query
values; `url` is retained as a compatibility alias of `finalUrl`.

## Configuration and boundaries

Configuration is loaded and resolved once during extension startup. Registered
search and fetch tools consume that immutable resolved snapshot; changing the
file or environment requires an extension reload.

The single configuration file is:

```text
~/.pi/agent/pi-kits.json
```

Persistent settings are namespaced under `web-kits.search` and `web-kits.fetch`. The
shared package validates the unified file; web-kits retains routing and fetch
semantic validation. Missing files and omitted `web-kits` use defaults; invalid or
unreadable files fail without fallback. All enabled switches default to true;
`web-kits.enabled: false` returns before registration and cleanup, and disabled fetch
skips spool cleanup. SearXNG URL/key and GitHub credentials stay outside JSON:
SearXNG uses environment variables, and GitHub uses the local `gh` credential
store.

The implementation assumes a trusted, single-user local agent. It rejects
non-HTTP(S) URLs, bounds response and command output, and uses basic temporary
file permissions, but it does not attempt to be a complete SSRF sandbox or
protect against a host-level bash escape.

## Codex boundary

Codex is only a search provider. Its Rust `web.run(open)` implementation sends
an `open` command to a remote Codex `alpha/search` service through a Rust HTTP
client. This extension deliberately does not implement or call that path for
`web_fetch`.
