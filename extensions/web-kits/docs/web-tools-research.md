# Web-tools research notes

## Scope

`web-tools` is a Pi integration layer around two local-facing tools:

```text
web_search -> SearXNG or Codex alpha/search
web_fetch  -> native HTTP or GitHub API/clone
```

It is not a model provider and does not own Codex OAuth storage or refresh.

## Fetch decisions

### Ordinary web pages

The default path uses Node's native `fetch` implementation. It does not spawn
`curl`, does not use a browser, and does not execute page JavaScript. The
response body is streamed to a bounded temporary file, decoded as text/HTML/JSON/XML,
and represented as `content.txt`.

### GitHub

GitHub repository and code URLs use a dedicated handler:

```text
small repository -> shallow clone
large repository -> gh api
private repository -> gh api or gh repo clone
clone failure   -> API fallback
```

The handler supports repository root, tree and blob URLs. A clone is stored in a
local temporary cache and returned as `repositoryPath`; the generated result is
also stored in a per-fetch file exposed as `savedContent.path`.

The clone is never used as an execution workspace automatically. No dependency
installation, build, test, hook, submodule recursion or repository script is
run by this extension.

### Why not curl or Codex open?

`curl` is a shell-level escape hatch rather than a stable typed implementation.
Native `fetch` gives the extension an AbortSignal, response stream and explicit
body limit without shell process handling.

Codex's Rust `web.run(open)` is a remote command sent to the Codex `alpha/search`
service through a Rust HTTP client. It is not a local file-fetch implementation.
This project deliberately never implements a Codex `open` fetch backend. Codex
remains a `web_search` provider only.

`gh api` is retained because GitHub authentication, repository contents and
private repository access are domain-specific capabilities. It is invoked with
fixed argument arrays and no shell.

## Configuration boundary

All persistent settings use one file:

```text
~/.pi/agent/pi-kits.json
```

The file is namespaced:

```json
{
  "web-kits": {
    "search": {},
    "fetch": {}
  }
}
```

SearXNG URL/key remain environment-only. GitHub credentials remain owned by the
local `gh` CLI. Missing files use defaults; invalid files fail without fallback.

## Local persistence

Every successful fetch saves text. The stored file is bounded to 50 MiB and
expires after the temporary-file TTL. Public output is metadata-only: `url`
(an alias of `finalUrl`), `finalUrl`, `source`, optional `title`, `contentType`,
`contentLength`, `repositoryPath`, and
`savedContent: { path: string, bytes: number, truncated: boolean, expiresAt?: string,
truncation?: { totalBytes: number, outputBytes: number, totalLines?: number,
outputLines?: number } }`. Use `read` on `savedContent.path` for the content;
no body, preview or summary is returned. There are no top-level `fullOutputPath`,
`expiresAt`, `truncation`, `text` or `isPreview` fields.

`savedContent.bytes` is the UTF-8 byte count of saved extracted/decoded/rendered
text, not HTTP `Content-Length`. `savedContent.truncated` only indicates that
saved text was limited; the file is not a guarantee of the complete original
page, even when this flag is false. Internal `FetchResponse` and fetching/storage
flows are unchanged; internal `fullOutputPath` may still identify the file.

The temporary path is not a security boundary. A trusted local agent is assumed,
and the host's session/transcript may also retain tool output.

## Limits and errors

- final fetch text: 50 MiB;
- serialized fetch output object: 50 KiB (metadata only);
- search output retains its existing line limit;
- GitHub root README: no independent limit; shares the 50 MiB saved-content limit;
- GitHub tree listing: 200 entries;
- command stdout: bounded separately from final content;
- native and command operations: cancellable and time-bounded.

Fetch errors are classified and do not include response bodies, command stderr or
raw child-process diagnostics.
