# Subagent configuration

This is the central configuration reference for the subagent extension.
See [usage.md](usage.md) for tools, views, task lifecycle, and native review workflows;
see [architecture.md](architecture.md) for implementation interfaces.

- [Configuration layers](#configuration-layers)
- [Extension settings](#extension-settings)
- [User-defined agent types](#user-defined-agent-types)
- [Runtime configuration](#runtime-configuration)
- [Codex options and review targets](#codex-options-and-review-targets)
- [Worker extension allowlist](#worker-extension-allowlist)
- [Configuration compatibility and source references](#configuration-compatibility-and-source-references)

## Configuration layers

| Layer | Location | Scope |
| --- | --- | --- |
| Extension | `<agent-dir>/pi-kits.json` → `subagent` | Activation, mux, managed concurrency, and Pi worker extension loading |
| Named agent | `agents/<type>.md` frontmatter and body | Reusable metadata, runtime/session defaults, and instructions |
| Tool call | `subagent` / `resume_subagent` parameters | Task input and runtime-owned session/task options under `runtime_config` |

These layers are not one recursively merged configuration object.
A project agent file replaces a same-name global file as a whole; agent session
fields override spawn-call fields per key; call-only task settings are never
taken from an agent file. Retained session settings cannot change on resume.
The detailed rules and examples below distinguish each case.

## Extension settings

Edit `<agent-dir>/pi-kits.json` and run `/reload`. The default agent directory is
`~/.pi/agent/`; `PI_CODING_AGENT_DIR` overrides it, including `~` expansion.
A missing file or field uses defaults. Invalid JSON, invalid supported fields,
or an unreadable file fail explicitly rather than silently falling back.

```json
{
  "subagent": {
    "enabled": true,
    "mux": "herdr",
    "maxConcurrent": 4,
    "extensionAllowlist": ["builtin:codemode", "builtin:tool-search"]
  }
}
```

| Field | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Enable the independent extension, subject to mux/environment requirements |
| `mux` | None | Only `"herdr"` is supported; must be explicitly configured |
| `maxConcurrent` | `4` | Integer 1–32; limits executing managed tasks, not retained idle sessions or independent native interaction |
| `extensionAllowlist` | `["builtin:codemode", "builtin:tool-search"]` | Pi extension source/selection array; replaces defaults as a whole, `[]` loads only the worker bridge |

Activation requires `enabled: true`, explicit `mux: "herdr"`, and exactly
`HERDR_ENV === "1"`. Otherwise no tools, commands, or hooks are registered.
There is no probing, automatic mux selection, or fallback. Herdr normally supplies
`HERDR_PANE_ID` for view placement; its CLI executable defaults to `herdr` and
can be overridden with `HERDR_BIN_PATH`. These are environment variables, not
fields in `pi-kits.json`.

There is no global `subagent.runtime_config`, model, thinking, or `keep_alive`
setting in this section. Configure those on a named agent or the relevant tool call.
Extension settings are validated and defaulted by `@pi-kits/config`.
Full repository fields are published in the [example](../../../pi-kits.example.json)
and [JSON Schema](../../../pi-kits.schema.json).

## User-defined agent types

There are **no embedded agent definitions or installed templates**. Create your
own Markdown files in these directories:

1. `<cwd>/.pi/agent/agents/*.md` — project, highest priority.
2. `$PI_CODING_AGENT_DIR/agents/*.md` — global, normally `~/.pi/agent/agents/`.

The filename without `.md` is the type name, matching `gotgenes/pi-subagents`.
Names are resolved case-insensitively. A project file **replaces the entire**
same-name global definition, not individual fields; `enabled: false` can hide a
global type. Replaced global files are not read or validated. Duplicate names
within one directory are errors. Definitions are
read afresh when listing or spawning; editing a file affects new tasks, not
already queued/running tasks. Invalid definitions fail explicitly rather than
falling back to a less restricted global configuration. Each agent file has a
64 KiB limit.

For example, a user-created `.pi/agent/agents/auditor.md` could contain:

```markdown
---
description: Review code for security issues
display_name: Auditor
model: anthropic/claude-sonnet-4-6
thinking: high
runtime_config:
  tools: read, grep, find, bash
  disallowed_tools: edit, write
  inherit_context: false
---
You are a security reviewer. Report issues with file paths and evidence.
Do not modify files.
```

Call `list_subagent_types` to discover names, then:

```json
{
  "subagent_type": "auditor",
  "description": "Review authentication",
  "prompt": "Review the authentication code for vulnerabilities."
}
```

Pass this object to `subagent`. Omitting `subagent_type` retains the existing
ad-hoc task behavior; it does not select an embedded or fallback named agent.
Unknown and disabled names are rejected before creating a worker.

Supported YAML frontmatter fields use the reference extension's snake_case names:

| Field | Behavior when omitted |
| --- | --- |
| `description` | Filename; shown in the type catalogue. |
| `display_name` | Type name; shown beside the task in widgets, views, and tool cards. |
| `runtime` | Call parameter, then `pi`; supports `pi` and `codex`. |
| `runtime_config` | Call session settings, then runtime defaults; generic record of session-only configuration interpreted by the selected runtime (see [Runtime configuration](#runtime-configuration)). |
| `model` | Call parameter, then parent model for Pi or Codex's own default. |
| `thinking` | Call parameter, then parent thinking for Pi or Codex's own effort default. |
| `enabled` | `true`; `false` disables selection. |
| `run_in_background` | Call parameter, then `true`. |
| `keep_alive` | Call parameter, then `false`; retain the runtime after completion even without an open view. |

Configured model, thinking, background mode, and keep-alive policy take precedence over call
parameters, including explicit `false`. Runtime session settings, including Pi's
`runtime_config.inherit_context`, take precedence per key as described above. Thinking is a
non-empty string interpreted by the selected runtime. For Pi, it is passed
directly to Pi, which owns the supported levels. The Codex adapter accepts
`off`, `none`, `minimal`, `low`, `medium`, `high`, and `xhigh`; `off` maps to
`none`. It also checks that the selected model supports the mapped effort.
Pi's `max` is not accepted by the Codex adapter. The Markdown body remains a
generic agent instruction; its interpretation belongs to the runtime. Runtime
session fields belong under `runtime_config`, never at the frontmatter top level.

### Pi tools and prompt mode

Pi `runtime_config.tools` names include Pi built-ins (`read`, `bash`, `edit`, `write`,
`grep`, `find`, `ls`, `powershell`), `codemode`, `tool_search`, and tools registered
by explicitly whitelisted extensions. A denylist is applied after the allowlist;
missing requested tools fail before a model turn instead of being silently
ignored. Codemode cannot use tools outside the CLI allowlist/denylist. Tool
selection is not a sandbox: `bash` can still change files.

For Pi, `runtime_config.prompt_mode` controls how the named agent's Markdown
body is applied. Explicit prompt mode on an unnamed session is rejected because
there is no agent body to apply:

- `replace` (default): pass the body in a file via CLI `--system-prompt`, plus an
  empty file via `--append-system-prompt` to suppress discovered `APPEND_SYSTEM.md`.
  The body must be non-empty; Pi treats empty custom prompts as its default role.
- `append`: retain Pi's own base system prompt and pass the body in a file via
  `--append-system-prompt`, replacing discovered `APPEND_SYSTEM.md` rather than
  adding to it.

Both modes retain project `AGENTS.md`/`CLAUDE.md` context according to Pi's native
trust rules; they do not disable context-file discovery or bypass trust. Workers
do not override project trust, so trusted project skills can load normally.
The body is file content, never interpolated into shell commands. The role remains
active after completion for native terminal interaction and resume while the runtime
is retained.

Of the built-in runtimes, only Pi supports `runtime_config.prompt_mode`.
Codex ignores this foreign field, including `replace`, `append`, and malformed
values, whether supplied by frontmatter or a call. Omitting the key leaves
runtime defaults in effect; Pi's default is `replace`. Pi validates its own prompt
mode. Tool selection and prompt mode are session settings, not per-round controls.

## Runtime configuration

All runtime-exclusive fields belong inside `runtime_config`. The generic agent
parser reads only supported generic metadata and ignores unknown top-level
fields. Legacy top-level runtime-exclusive fields have no effect: move them into
`runtime_config`; there are no compatibility aliases. `model`, `thinking` and
the Markdown body remain generic.

The selected runtime adapter reads only its own fields, validates their types
and values, and partitions session settings from call-only task settings. Unknown
and foreign runtime fields are ignored, including malformed values; they are
never interpreted or checked against an unsupported-key whitelist. Agent
frontmatter supplies session settings; calls can supply both session and task
settings in the same record. `review_target` in agent/session configuration is
ignored, not inherited.

The shared tools allow unknown extras and forward raw `runtime_config` to the
runtime. Their schemas describe the optional Codex `review_target`, while its
conditional requirement is enforced by the Codex adapter. `inherit_context` is
a Pi-only session field inside `runtime_config`.
Pi's `runtime.prepareSpawn` handles it using opaque host context before queueing;
resume never recaptures parent context.

| Runtime | `runtime_config` key | Scope and default |
| --- | --- | --- |
| Pi | `tools` | Session; native Pi defaults. CSV or YAML array; `none`/empty disables all tools. Built-in and whitelisted extension tool names are accepted. |
| Pi | `disallowed_tools` | Session; no additional denylist. CSV or YAML array, applied after `tools`. |
| Pi | `inherit_context` | Session; `false` by default. Strict boolean; `true` snapshots the parent Pi branch before queueing. Resume never captures it again. |
| Pi | `prompt_mode` | Named-agent session only; `replace` by default, or `append`. Controls the agent body's system-prompt role. |
| Codex | `runtime_args` | Session; no additional options. CSV or YAML array; `review`/`search` are mapped by the adapter, other options go to its native CLI. |
| Codex | `review_target` | Call-only task setting; no default. Required on each native-review round; ignored in agent/session configuration, rejected for ordinary Codex turns. |

Named-agent session settings take precedence over spawn-call settings **per
key**, not by replacing the entire record. Call settings supply session keys
absent from the definition. This precedence applies only to the selected runtime's
own session fields. Task settings come only from the call: an agent's
`runtime_config.review_target` is ignored, even if malformed, and never supplies
a target for a call.

For example, Pi tool configuration can be supplied to an unnamed `subagent`:

```json
{
  "runtime": "pi",
  "prompt": "Inspect the authentication code without editing files.",
  "runtime_config": {
    "tools": "read, grep, find, bash",
    "disallowed_tools": "edit, write"
  }
}
```

Session settings are applied once at spawn and remain on resume. A
`resume_subagent` call may omit the retained runtime's own session fields or
redundantly repeat values that normalize identically to the retained
configuration, but cannot change them. In particular, there is no per-round
mutation of Pi tools/denylist/prompt mode/inheritance or Codex `runtime_args`.
Unknown and foreign extras are ignored on resume, including malformed values.
Runtime task parameters reset on every round; omission never inherits a previous
`review_target`. The adapter validates its own resume fields using the retained
runtime and session settings.

Top-level runtime-exclusive frontmatter fields are ignored, not migrated or
aliased. Pi ignores Codex fields, and Codex ignores Pi fields, without
interpreting or validating their values. Tool calls also use `runtime_config`;
top-level runtime-exclusive extras such as `review_target` have no effect.
Internal trusted `ManagerOptions` launch/deployment injection is unaffected by
this public configuration contract.

## Codex options and review targets

Codex session options belong under `runtime_config.runtime_args`, as CSV or an
array of strings. For example, a named `reviewer.md` can contain:

```markdown
---
runtime: codex
model: gpt-6.1-sol
thinking: medium
keep_alive: true
runtime_config:
  runtime_args: [review, search]
---
Review correctness and report actionable findings.
```

`review` selects native review instead of an ordinary turn; `search` enables
live web search for the thread. Codex's native review delegate disables web search,
so listing both does not enable search inside the review itself.
Other entries are forwarded as native app-server switches: bare names gain
`--`, existing leading `-` is preserved, and values use `--option=value`.
This is not a shell command line or a way to select arbitrary subcommands.
Entries must be nonempty strings without control characters; native Codex validates
option availability. Parsing itself does not start a process.

`review_target` is call-only and must be supplied on every native-review spawn
or resume. Agent/session values are ignored, not used as defaults:

| Target | Required fields |
| --- | --- |
| `uncommittedChanges` | `{ "type": "uncommittedChanges" }` |
| `baseBranch` | `{ "type": "baseBranch", "branch": "main" }` |
| `commit` | `{ "type": "commit", "sha": "<SHA>" }`; optional `title` string or null |
| `custom` | `{ "type": "custom", "instructions": "Review security issues" }` |

For the named reviewer above:

```json
{
  "subagent_type": "reviewer",
  "description": "Review changes against main",
  "runtime_config": {
    "review_target": { "type": "baseBranch", "branch": "main" }
  }
}
```

Omit `prompt` for structured targets. A custom target may include a call-level
prompt, which is appended to its instructions. Ordinary Codex tasks require a
nonempty prompt and reject `review_target`. Review does not automatically copy
the agent body's developer instructions into a custom target; place required
review instructions in `custom.instructions`. Native `review_model` policy may
override the thread model. See [native review and search](usage.md#native-review-and-search)
for execution, continuation, and native-result behavior.

The built-in Codex adapter uses fixed `workspace-write` / `never` sandbox and
approval settings; these are not agent configuration fields.
Codex uses its own model/thinking defaults, never the parent Pi defaults.
It does not support Pi context cloning or Pi extension loading.

## Worker extension allowlist

Configure `subagent.extensionAllowlist` in agent-dir `pi-kits.json`:

```json
{
  "subagent": {
    "mux": "herdr",
    "extensionAllowlist": ["builtin:codemode", "builtin:tool-search"]
  }
}
```

Every Pi worker explicitly loads this shared list alongside its bridge.
Codex does not use this list. The list
replaces the defaults as a whole: `[]` loads only the bridge. It controls **which
extension code is loaded**, while Pi's session `runtime_config.tools` selects
**which tools are enabled**; loading codemode does not automatically activate it. Agent Markdown
cannot add extensions. Entries are native Pi extension sources, resolved by Pi's
package manager rather than a kit-specific prefix table. For example:

```json
"extensionAllowlist": [
  "builtin:codemode",
  "builtin:tool-search",
  "npm:@narumitw/pi-chrome-devtools"
]
```

To select only named resources from an installed package, use an object:

```json
"extensionAllowlist": [
  "builtin:codemode",
  "builtin:tool-search",
  {
    "source": "git:github.com/aqua2k1/pi-kits",
    "extensions": ["web-kits"]
  },
  "npm:@narumitw/pi-chrome-devtools"
]
```

Pi locates the package, then the resolver reads its `package.json`
`extensionResources` declaration. The repository exposes each independent
extension name (for example `stats`, `subagent`, and `web-kits`). Each individual
extension package also declares its own name. Only independent resource names
are exposed; there are no group names or compatibility aliases.
For example, the repository declares:

```json
"extensionResources": {
  "web-kits": "./extensions/web-kits/index.ts"
}
```

A resource maps to a package-relative entrypoint or an array of entrypoints.
Selected entries must already be enabled resources in the package's explicit
Pi manifest. Unknown names, absent declarations, and undeclared/escaping paths
fail before worker creation; there is no name-to-path guess or whole-package
fallback. `extensions: []` loads nothing from that source and does not resolve
or install it. The [repository configuration example](../../../pi-kits.example.json)
uses this empty selection deliberately; change it to `["web-kits"]` to opt in.
Defaults still load only codemode and tool-search. Packages without named
declarations (such as Chrome DevTools) can
still be loaded using their plain source string.

Pi resolves installed npm/git packages and reads their declared extension
resources. Plain package source strings load all their declared extensions,
not just one tool.
Missing packages follow Pi's native installation behavior; only list trusted
sources. Files/directories remain supported: absolute paths, `~/...`, and paths
relative to the agent directory (never the task/project cwd). Resolved enabled
extension paths are explicitly passed to the child CLI; unrelated parent packages
are not loaded. A source with no enabled extension resources fails before worker
creation. The tool `tool_search` is provided by `builtin:tool-search`.
Reload the parent after changing the whitelist. Extensions run with full process
permissions, so this is a loading policy, not an OS sandbox.

## Configuration compatibility and source references

Top-level `subagent` settings override the same legacy `workflow.subagent`
fields; unspecified fields retain legacy values before defaults are applied.
Legacy `workflow.enabled: false` disables subagents unless top-level
`subagent.enabled` explicitly overrides it. Prefer the independent top-level settings.
Configuration is validated by [the shared schema](../../../shared/config/schema.ts)
and resolved by [the shared config reader](../../../shared/config/index.ts).

The [shared tool parameter schemas](../index.ts) expose an optional Codex
`runtime_config.review_target` for `subagent` and `resume_subagent`, while
allowing other runtime options and forwarding raw `runtime_config`. Top-level
`review_target` is not a supported parameter. Runtime validation covers only
the selected adapter's own fields;
unknown and foreign fields are ignored, including malformed values. See
[Pi configuration](../runtime/pi/config.ts),
[Codex configuration](../runtime/codex/config.ts), and the
[Codex review target schema](../runtime/codex/schema.ts).

