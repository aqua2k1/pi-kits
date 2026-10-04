# pi-kits

Workspace tools, usage reports, commit workflows, web tools, and a Gruvbox theme for [Pi](https://pi.dev).

## Install

```sh
pi install https://github.com/aqua2k1/pi-kits.git
```

Requires Pi and Node.js >= 22.19.

## Kits

| Kit | Features |
| --- | --- |
| [workspace-kit](packages/workspace-kit/README.md) | nvim, lazygit, yazi, open files/URLs, reply and request previews |
| [usage-kit](packages/usage-kit/README.md) | Provider usage and token/cost reports |
| [workflow-kit](packages/workflow-kit/README.md) | Conventional Commits, desktop notifications, user questions, and opt-in Herdr subagents |
| [web-kit](packages/web-kit/README.md) | Web search and web/GitHub fetching |

Select `gruvbox` in `/settings`. Toggle resources with `pi config`.

## Configuration

Settings live in agent-dir `pi-kits.json` (honoring `PI_CODING_AGENT_DIR`),
validated and defaulted through `@pi-kits/config`. Edit then `/reload`.
See the [configuration example](pi-kits.example.json) and
[JSON schema](pi-kits.schema.json).

### Herdr subagents (MVP)

Opt in with `workflow.subagent`:

```json
{
  "workflow": {
    "subagent": { "mux": "herdr", "enabled": true, "maxConcurrent": 4 }
  }
}
```

Only `herdr` is supported. Activation requires `HERDR_ENV === '1'`,
`workflow.enabled`, `subagent.enabled`, and explicit `mux: "herdr"`.
`enabled` defaults to `true`, but `mux` is undefined by default, so no mux
configuration means no activation. Disabled or unconfigured subagents register
no tools, hooks, or commands. There is no environment probing or fallback.
`maxConcurrent` is an integer from 1 to 32 (default 4).
`extensionAllowlist` explicitly loads trusted extensions in every worker, defaulting
to `["builtin:codemode", "builtin:tool-search"]`. An explicit list replaces these
defaults; `[]` loads only the worker bridge. Parent extensions are not inherited.

Tools: `subagent`, `get_subagent_result`, `steer_subagent`, `stop_subagent`.
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
names and `subagent` with `subagent_type` to select one. No agent profiles or
templates are embedded.
See [workflow-kit](packages/workflow-kit/README.md#herdr-subagents-mvp) for details.
