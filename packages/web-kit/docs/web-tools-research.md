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
also stored in a per-fetch `fullOutputPath`.

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
~/.pi/agent/web-tools-config.json
```

The file is namespaced:

```json
{
  "search": {},
  "fetch": {}
}
```

SearXNG URL/key remain environment-only. GitHub credentials remain owned by the
local `gh` CLI. The old `web-search-config.json` format is not read or migrated.

## Local persistence

Successful textual results are saved by default. The stored file is bounded to
50 MiB and expires after the temporary-file TTL. The model receives the full path
for later `read` access; large results include only a short inline preview to
avoid wasting context.

The temporary path is not a security boundary. A trusted local agent is assumed,
and the host's session/transcript may also retain tool output.

## Limits and errors

- final fetch text: 50 MiB;
- inline preview: 8 KiB;
- inline output: 50 KiB / 2,000 lines;
- GitHub tree listing: 200 entries;
- command stdout: bounded separately from final content;
- native and command operations: cancellable and time-bounded.

Fetch errors are classified and do not include response bodies, command stderr or
raw child-process diagnostics.
