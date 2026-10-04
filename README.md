# pi-kits

Workspace tools, usage reports, commit workflows, web tools, and a Gruvbox theme for [Pi](https://pi.dev).

## Install

```sh
pi install https://github.com/aqua2k1/pi-kits.git
```

Requires Pi and Node.js >= 22.19.

## Independent extensions

Each extension lives directly under `extensions/<name>/` with its own explicit
Pi manifest. There are no kit groups or redundant `src/extensions` intermediate directories.

| Resource | Features | Documentation |
| --- | --- | --- |
| `terminal` | nvim, lazygit, yazi | [Workspace](docs/workspace.md) |
| `open` | Open files, URLs, directories | [Workspace](docs/workspace.md) |
| `preview` | Reply preview | [Workspace](docs/workspace.md) |
| `context-preview` | Request payload preview | [Workspace](docs/workspace.md) |
| `provider-usage` | Provider usage widget | [Usage](docs/usage.md) |
| `stats` | Token/cost HTML reports | [Usage](docs/usage.md) |
| `commit` | Conventional Commits | [Workflow](docs/workflow.md) |
| `notify` | Desktop completion notifications | [Workflow](docs/workflow.md) |
| `ask-user-question` | Native user questions | [Workflow](docs/workflow.md) |
| `subagent` | Opt-in Herdr subagents | [Workflow](docs/workflow.md#herdr-subagents-mvp) |
| `web-kits` | Web search and web/GitHub fetching | [Web](extensions/web/README.md) |

Shared runtime helpers live in `shared/`, configuration in `shared/config/`,
test helpers in `tests/helpers/`, and themes in `themes/`.
From a checkout, load one extension with `pi -e ./extensions/stats`.

Package metadata exposes each resource name above. Existing `workspace-kit`,
`usage-kit`, `workflow-kit`, and `web-kit` selections remain as compatibility
resource declarations; they no longer correspond to package directories.
`web-kits` is the public web resource name; `web` and `web-kit` remain compatible aliases.
Configuration uses top-level extension settings; legacy `workspace`, `usage`,
and `workflow` sections remain readable for compatibility. The internal `web`
structure is unchanged.

Select `gruvbox` in `/settings`. Toggle resources with `pi config`.

## Transcript rendering

All ten tools and subagent completion notifications share `shared/ui/renderers.ts`.
Collapsed rows show a name, status, and bounded preview; expand with Ctrl+O for
full content and structured details. Streaming, cancellation, errors, and
truncation remain explicit. Rendering does not change model-facing content or
machine output. Shared helpers register no tools or lifecycle handlers.

## Configuration

Settings live in agent-dir `pi-kits.json` (honoring `PI_CODING_AGENT_DIR`),
validated and defaulted through `@pi-kits/config`. Edit then `/reload`.
See the [configuration example](pi-kits.example.json) and
[JSON schema](pi-kits.schema.json).

Top-level settings are `terminal`, `open`, `preview`, `contextPreview`,
`providerUsage`, `stats`, `askUserQuestion`, `subagent`, `commit`, `notify`, and
`web`. Each extension's `enabled` controls it independently; there is no new
group-level switch. The internal structure of `web` is unchanged.

Legacy `workspace`, `usage`, and `workflow` sections are still read. Top-level
settings override the same legacy fields; unspecified fields retain legacy values
before defaults are applied. A legacy group's `enabled: false` still disables its
children unless a child explicitly sets top-level `enabled` to override it.

### Herdr subagents (MVP)

Opt in with top-level `subagent`:

```json
{
  "subagent": { "mux": "herdr", "enabled": true, "maxConcurrent": 4 }
}
```

Only `herdr` is supported. Activation requires `HERDR_ENV === '1'`,
`subagent.enabled`, and explicit `mux: "herdr"`.
`enabled` defaults to `true`, but `mux` is undefined by default, so no mux
configuration means no activation. Disabled or unconfigured subagents register
no tools, hooks, or commands. There is no environment probing or fallback.
`maxConcurrent` is an integer from 1 to 32 (default 4).
`extensionAllowlist` explicitly loads trusted extensions in every worker, defaulting
to `["builtin:codemode", "builtin:tool-search"]`. An explicit list replaces these
defaults; `[]` loads only the worker bridge. Entries use native Pi extension
sources, including npm/git packages, built-ins, and files/directories. To select
only web from this Git package, use
`{ "source": "git:github.com/aqua2k1/pi-kits", "extensions": ["web-kits"] }`.
Logical names are declared in package metadata, not tied to installation paths.
Parent extensions are not inherited.

Tools: `subagent`, `resume_subagent`, `get_subagent_result`, `steer_subagent`,
`stop_subagent`, and `list_subagent_types`. Resume reuses an idle, retained Pi
session/history and enters the same concurrency queue; it never restarts a
closed/disconnected worker or interrupts native user interaction.
`/subagent:views [id] [open|focus|close]` manages views attached to existing Pi
terminals for inspection and control. The shared manager places the first view
right of the parent and subsequent views below the last surviving view; every
adapter follows this policy. Closing a view does not kill the worker.
Background tasks use Herdr's native Pi terminals plus a worker bridge, not a
custom PTY. `worker.ts` is loaded only via explicit `-e`, never a package manifest
entry. The first version supports general tasks with `model` and `thinking`
parameters, not scheduled tasks or worktree management. Named agents are entirely
user-defined Markdown in `~/.pi/agent/agents/` and `<cwd>/.pi/agents/`; project
same-name definitions replace global ones. Use `list_subagent_types` to discover
names and `subagent` with `subagent_type` to select one. Agent MD bodies are fixed
system prompts. `inherit_context: true` clones the parent current branch into a
separate child session; default false starts fresh. Resume keeps the child history.
Parent extensions are never implicitly loaded by cloning. No agent profiles or
templates are embedded.
See [workflow documentation](docs/workflow.md#herdr-subagents-mvp) for details.
