# Subagent usage

See the [package overview](../README.md) for architecture and minimal configuration.

- [Herdr subagents](#herdr-subagents)
- [User-defined agent types](#user-defined-agent-types)
- [Parent context cloning](#parent-context-cloning)
- [Worker extension allowlist](#worker-extension-allowlist)

## Load

From the repository root, load the independent entry in Pi:

```sh
pi -e ./extensions/subagent
# Or persist a local extension installation:
pi install ./extensions/subagent
```

Disable duplicate installations before loading. Loading alone does not activate
subagents: configure the mux and run inside Herdr as described below.
Herdr's CLI defaults to `herdr`; `HERDR_BIN_PATH` can override its executable path.
Opening views also requires the parent pane's `HERDR_PANE_ID` supplied by Herdr.

## Herdr subagents

Subagents run general tasks in the background using Pi or Codex runtimes.
Herdr owns native terminal views; the runtime owns the execution session.
The Pi behavior described below uses native Pi terminals plus a worker bridge;
Codex-specific behavior is described in [Codex runtime](#codex-runtime). The extension does not build its own PTY. Task parameters
include `model` and `thinking`, plus an optional named `subagent_type` backed by
user Markdown files. This first version does not support scheduling or worktrees.

Configure `<agent-dir>/pi-kits.json` (normally `~/.pi/agent/pi-kits.json`,
honoring `PI_CODING_AGENT_DIR`, including `~` expansion) and `/reload`:

```json
{
  "subagent": { "mux": "herdr", "enabled": true, "maxConcurrent": 4 }
}
```

Configuration is validated and defaulted through `@pi-kits/config`. `mux` accepts
only `"herdr"` and has no default; `enabled` defaults to `true`.
`maxConcurrent` limits executing tasks, not retained idle Pi terminals; it is an
integer from 1 to 32, defaulting to 4. Completed terminals remain available for
inspection until parent-session cleanup. Activation requires
`subagent.enabled`, explicit `mux: "herdr"`, and
exactly `HERDR_ENV === '1'`. There is no environment probing, automatic mux
selection, or fallback. If unconfigured, disabled, or outside that Herdr
environment, the entry registers no tools, hooks, or commands.

| Tool | Purpose |
| --- | --- |
| `subagent` | Start an ad-hoc task or select a user-defined agent type. |
| `resume_subagent` | Continue a finished task in its retained Pi session/history. |
| `list_subagent_types` | Discover user-defined agents and their source/configuration. |
| `get_subagent_result` | Retrieve the current managed round's status/result and live session state. |
| `steer_subagent` | Send guidance to a running task. |
| `stop_subagent` | Cancel a queued or running task. |

Use `/subagent:views <id> open` to open a view attached to an existing Pi
terminal. Placement is automatic: the first view opens right of the parent Pi,
and each subsequent view opens below the last surviving view, forming a right-side
column. There is no direction picker or right/down command argument. This policy
belongs to the shared subagent manager and applies to every mux adapter; adapters
only execute the supplied placement instruction. Concurrent opens are serialized
across agents. Closing a view only detaches it; it does not kill the worker.
Use `/subagent:views <id> close` to close an attachment from the parent Pi, or
`focus` to focus an existing view. Running `/subagent:views` without arguments
opens the shared lower-half docked panel with a single live agent list, without
tabs or a second action menu. Passing only an ID preselects that agent.
Clicking an agent or pressing Enter immediately opens its view, or focuses the
existing view. Up/Down and the mouse wheel select; Esc closes only the panel.
Press `y` to copy the selected agent's full ID, or `d` to delete it after
confirmation. These actions close the panel; deletion closes the native terminal
and removes the manager record but retains session files. Explicit `copy` and
`delete` command actions are also supported.
Queued agents without a terminal cannot open a view yet. Use the explicit
`close` command above to detach a view without stopping its worker.
Subagent views, tool cards, and `subagent-notification` completion messages share
the header: status icon, `agent name(runtime display name)`, frontmatter-configured model value, task description,
eight-character ID, and status. Agent names fall back from `display_name` to the
type name, then `Subagent`; runtime labels come from the adapter, not UI-specific
runtime branches. Unavailable models appear as `—`. Workers report actual model
IDs/names, including native model changes. Headers show the configured
frontmatter `model` verbatim; runtime metadata never rewrites that display value.
Without a frontmatter model, the header shows `—`, not a call-parameter or
runtime-reported model. Tool results add a
one-line result/error preview. Full IDs, paths, timestamps, counters, and full
prompts/results appear when expanded with Ctrl+O. Rendering does not change tool
data or JSON/print output.

Views are native control attachments, not read-only viewers.

In TUI mode, a live tree-style status area stays above the editor while tasks are
active or queued, independently of the views panel. It shows state, current tool
activity, elapsed time, assistant turns, tool calls, cumulative tokens, context
percentage (when available), and compactions. Tokens exclude repeated cache-read
prefixes. Up to four active tasks are expanded; additional active/queued tasks
are summarized to bound widget height. Completed rows linger for five seconds;
disconnected cleanup errors remain visible until resolved. Results and terminals
remain available after rows disappear. Shutdown/reload removes the widget and
its refresh timer.

Task and session states are separate: `status` remains the last managed task's
state/result; `sessionState` is `idle`, `running` (managed execution),
`interactive` (native/user execution without an active managed task),
`disconnected`, or `closed`. Native guidance during a managed run remains part
of that managed batch. Session state is absent
before a worker connects. Opening a view does not make a session interactive.
Native conversations update session activity through IPC and remain visible in
the widget until Pi settles, including retries and continuations. They do not
overwrite the managed result/statistics, emit another completion notification,
or acquire a managed concurrency slot. An IPC task cannot take over native work.
Use `resume_subagent` with `agent_id`, a new `prompt` (or an explicit
`review_target` for native review), optional `description`, and optional
`run_in_background`. It keeps the same ID, process, terminal, view,
session file/history (including native conversations), and original agent
instructions. Agent files are not re-read. The worker's current model/thinking/
tool settings are not reset, so native user changes remain in effect; requested
agent tools must still be available as with spawn. Omitted description retains
the current task name.
The original agent's `run_in_background` setting takes precedence; otherwise
resume defaults to background, just like spawn.

Resume requires a finished managed task and an idle, retained, connected worker;
completed, cooperatively stopped, and errored rounds may resume. Interactive,
active, closed, or disconnected sessions are rejected without replacing their
results. No process is restarted. Each accepted resume increments `round` and
resets the current result/error, per-round usage, timestamps, waiter claims, and
completion notification. Earlier results remain in tool history and Pi's session
file. Foreground waits are bound to their round even if another round starts.

Resumed rounds enter the same FIFO concurrency queue as new tasks. If native
work starts while queued, dispatch fails rather than taking over the user.
The worker also atomically checks idle at receipt to cover IPC races. Canceling
a queued/preflight resume never aborts native work. All workers, including native/user sessions, remain owned by the parent agent.
Control-connection loss closes the runtime and its views even when a resumed
round has not acknowledged receipt. Unresponsive managed cancellation also
closes the runtime after its timeout. The concurrency claim is released only
after cleanup succeeds; failed cleanup retains ownership for retry.

`stop_subagent` cancels the managed task, not independent native/user work, and
retains its terminal when Pi cooperates;
if cancellation does not settle within five seconds, the terminal is destroyed.
Parent session shutdown/reload cleans up owned workers and views. Shutdown
coalesces concurrent cleanup calls and retries failures up to three times with
short backoff. Successfully closed runtimes are not closed again; failed runtime,
view, and temporary-directory ownership is retained for retry. The manager is
released only after cleanup succeeds. Exhausted retries report the affected agent
IDs and resource kinds through Pi's extension error handling. This is best-effort
cleanup; ownership is not persisted across processes or extension-runtime
replacement. Pi workers self-terminate when the parent control connection is
lost, including while idle or in native interaction. Workers share
the filesystem and credentials and are not a sandbox. They start with
`--no-approve`, so trust-gated project resources are not loaded automatically.
Workers also use `--no-extensions` and explicitly load the worker bridge plus
`subagent.extensionAllowlist`. Defaults are `builtin:codemode` and
`builtin:tool-search`; arbitrary parent/user extensions, including permission
extensions, are not inherited. Add trusted extensions to this list explicitly.

The worker bridge uses authenticated loopback TCP JSONL, not terminal screen
parsing. Command frames and returned results are bounded to 64 KiB; truncated
results identify the session file. State is session-scoped: cross-process task
recovery and automatic reconnect are not implemented. IPC loss triggers cleanup
for active, idle, and native sessions; there is no independent detach mode.
Pi workers abort work, invalidate queued/preflight submissions, and invoke
signal-based graceful shutdown when their control channel closes or fails.
Failed manager cleanup is reported as `disconnected`; use `stop_subagent` to
retry, including after a task has finished. Finished sessions retain their last
task result even when their runtime is closed.

Only [index.ts](../index.ts) is listed in the [root](../../../package.json)
and [subagent](../package.json) Pi manifests. The background Pi loads
[runtime/pi/worker.ts](../runtime/pi/worker.ts) via an explicit `-e`; the worker is never auto-loaded
as a package resource.

## Codex runtime

Select `runtime: "codex"` in a tool call, or define a named agent:

```markdown
---
runtime: codex
description: Implement and verify code
model: gpt-6-luna
thinking: high
---
Implement the task and verify the result. Report relevant files and tests.
```

`runtime` is `pi` (default) or `codex`. Frontmatter overrides the call runtime.
Codex model/effort defaults come from Codex, never the parent Pi model/thinking.
The Markdown body is a developer instruction, not a replacement for Codex's
base instructions. Codex still discovers its own project instructions/config.
Pi `tools`/`disallowed_tools` do not apply to Codex and are ignored by its
adapter. Context cloning is unsupported: `inherit_context: true` never converts
or copies a Pi transcript into Codex. The extension allowlist applies only to Pi.

Codex currently requires CLI 0.160.0 (other versions are rejected until their
protocol is verified) and existing Codex authentication. Each subagent owns a private app-server, with an
authenticated loopback WebSocket endpoint and a private temporary token file.
It does not use the user's shared daemon. `thread/start` creates the session;
each managed round maps to a Codex turn. Steering uses `expectedTurnId` and
cancellation targets only the managed turn. An interrupt RPC acknowledgment is
not completion: the manager waits for the terminal turn event. Results and
per-round statistics exclude independent native turns.

The adapter uses the fixed `workspace-write` sandbox and `never` approval
policy. These are not agent configuration fields. Unknown frontmatter fields,
including a `codex` block, are ignored without validation or activation.
Approval and user-input requests during headless managed execution are not
automatically granted. Only supported runtime/model/thinking values are used;
runtime names are resolved by the runtime registry at launch.

Native Codex TUI views are created lazily on demand, including while a managed
task is running, using `codex --remote … resume <thread-id>` against the same
app-server. They are writable, not screen-scraped viewers. Attachment waits for
the managed `turn/start` or `review/start` to settle; opening/focusing/detaching a pane never
cancels or relinquishes that managed turn. Native input may steer or interrupt
it, and its terminal event still determines the managed result. Independent
native turns never overwrite the managed result or get canceled by
`stop_subagent`. Interactive requests are left to a live native TUI rather than
being rejected by the headless client.

Because Codex can treat `turn/start` on an active turn as steering, **exit the
native TUI before submitting a new managed round**. Closing/detaching the Herdr
view does not exit the native TUI and does not release this submission guard.
This guard does not restrict opening a pane for an already-running task.

Parent shutdown/reload, deletion, or control-connection loss closes both the
owned app-server and any owned native terminal. The app-server runs under a
small Node guardian with a dedicated POSIX process group and a parent IPC
channel. If the parent process disappears, the guardian sends SIGTERM and then
SIGKILL to its own group, including ordinary backend tool children; opening a
native TUI does not transfer backend ownership. This requires POSIX; Windows
launches are rejected rather than silently weakening the ownership guarantee.
Processes that deliberately leave the group, a forcibly killed guardian, and
Herdr workspace/native-attachment or token-directory remnants after abrupt
parent death are outside this fallback's guarantee. Session history remains in Codex's normal session
store; there is no automatic restart, reconnect, or cross-process task recovery.

### Native review and search

Codex agents can declare runtime-specific options as CSV or a YAML array:

```markdown
---
runtime: codex
runtime_args: review, search
model: gpt-6.1-sol
thinking: medium
description: Critical code review subagent
---
Review correctness, necessity, and better alternatives.
```

`runtime_args: [review, search]` is equivalent. The common agent parser retains
these fields; the selected runtime's pure parser interprets them. Pi rejects
`runtime_args`. The Codex adapter interprets `review` and `search` and forwards
other options to its native app-server CLI without an option-name whitelist.
Bare switch names gain a `--` prefix; options already starting with `-` are
preserved. Use `--option=value` for options with values. This is a switch-list
shorthand, not a shell command line or a way to replace the app-server with an
arbitrary subcommand. Codex validates native option availability and rejects
unsupported flags. No configuration starts a process during parsing.

`search` enables live web search in the thread (`web_search: live`). `review`
selects native `review/start` with inline delivery instead of ordinary
`turn/start`, preserving the managed thread, cancellation and native views.
Codex's native review delegate disables web search, so declaring both options
**does not enable web search inside the review itself**.

Specify the review scope on every `subagent` or `resume_subagent` call:

```json
{
  "subagent_type": "reviewer",
  "description": "Review changes against main",
  "review_target": { "type": "baseBranch", "branch": "main" }
}
```

`review_target` supports:

- `{ "type": "uncommittedChanges" }`: staged, unstaged and untracked changes.
- `{ "type": "baseBranch", "branch": "main" }`: changes against a base branch.
- `{ "type": "commit", "sha": "<SHA>", "title": null }`: one commit; title is optional.
- `{ "type": "custom", "instructions": "Review authentication for security issues" }`.

Review mode requires an explicit target; it is never guessed or reused from a
previous round. Non-review Codex tasks and Pi tasks reject `review_target`.
Omit `prompt` for structured targets: the native review protocol cannot carry
an additional task prompt. A custom target can include `prompt`, which is
appended to its instructions. Ordinary tasks still require a nonempty prompt.
Native review uses Codex's own review rubric and clears the thread's developer
instructions; the agent Markdown body is not automatically copied into a custom
review target. Put explicit review requirements in the custom target's
`instructions`. Codex's own `review_model` configuration may also override the
thread model; this adapter does not override that native policy. Review results
are collected from native `exitedReviewMode.review` items, including paginated
completion hydration.

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
falling back to a less restricted global configuration.

For example, a user-created `.pi/agent/agents/auditor.md` could contain:

```markdown
---
description: Review code for security issues
display_name: Auditor
model: anthropic/claude-sonnet-4-6
thinking: high
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
| `runtime_args` | No additional runtime options. Codex-only CSV or YAML array; `review`/`search` are mapped by its adapter, other options go to its native CLI. |
| `model` | Call parameter, then parent model for Pi or Codex's own default. |
| `thinking` | Call parameter, then parent thinking for Pi or Codex's own effort default. |
| `prompt_mode` | `replace` for Pi; accepts `replace` or `append`. Support is validated by the selected runtime at launch; Codex rejects explicit configuration. |
| `tools` | Native Pi defaults; CSV or YAML array, `none`/empty disables all tools. Built-in and whitelisted extension tool names are accepted. |
| `disallowed_tools` | No additional denylist; CSV or YAML array of tool names, applied after `tools`. |
| `inherit_context` | Call parameter, then `false`; `true` clones the parent current branch into an independent Pi session. |
| `enabled` | `true`; `false` disables selection. |
| `run_in_background` | Call parameter, then `true`. |

Configured model, thinking, background mode, and `inherit_context` take
precedence over call parameters, including explicit `false`. Thinking is a
non-empty string interpreted by the selected runtime. For Pi, it is passed
directly to Pi, which owns the supported levels. The Codex adapter accepts
`off`, `none`, `minimal`, `low`, `medium`, `high`, and `xhigh`; `off` maps to
`none`. It also checks that the selected model supports the mapped effort.
Pi's `max` is not accepted by the Codex adapter.
Tool names include Pi built-ins (`read`, `bash`, `edit`, `write`,
`grep`, `find`, `ls`, `powershell`), `codemode`, `tool_search`, and tools registered
by explicitly whitelisted extensions. A denylist is applied after the allowlist;
missing requested tools fail before a model turn instead of being silently
ignored. Codemode cannot use tools outside the CLI allowlist/denylist. Tool
selection is not a sandbox: `bash` can still change files.

For Pi, `prompt_mode` controls how the named agent's Markdown body is applied:

- `replace` (default): pass the body in a file via CLI `--system-prompt`, plus an
  empty file via `--append-system-prompt` to suppress discovered `APPEND_SYSTEM.md`.
  The body must be non-empty; Pi treats empty custom prompts as its default role.
- `append`: retain Pi's own base system prompt and pass the body in a file via
  `--append-system-prompt`, replacing discovered `APPEND_SYSTEM.md` rather than
  adding to it.

Both modes retain project `AGENTS.md`/`CLAUDE.md` context according to Pi's native
trust rules; they do not disable context-file discovery or bypass trust. Workers
use `--no-approve`, so untrusted project resources are not automatically approved.
The body is file content, never interpolated into shell commands. The role remains
active after completion for native terminal interaction and resume.

Of the built-in runtimes, only Pi supports `prompt_mode`. Both explicit
`replace` and `append` are rejected at launch when the effective runtime is
Codex, whether selected by frontmatter or a call parameter. Omission is preserved as
`undefined` in the parsed definition so runtime validation can distinguish an
explicit setting; the effective default for Pi is still `replace`.

## Parent context cloning

Set `inherit_context: true` in frontmatter or pass `inherit_context: true` to
`subagent`. Frontmatter takes precedence; `false` starts a fresh child session.
The parent current branch is frozen at invocation, before queueing. An independent
SessionManager uses Pi's native branch-cloning logic, then the child CLI opens
the private cloned JSONL with `--session`. The parent session, branch and file
are never switched or modified. No SDK AgentSession or text transcript injection
is used. Empty parent history falls back to a fresh session.

Clones retain native messages, images, completed tool calls/results, compaction
checkpoints, branch labels, and context edits. Unresolved calls (including the
currently executing spawn call) are omitted from the clone's model context via
context edits; raw cloned history is preserved, without inventing tool results.
Cloning uses the current branch, not the last leaf in a moving source file.
Resume continues the child history and never clones the parent again.

History cloning does not register parent extensions or grant their tools.
Workers still load only the bridge plus the shared explicit extension allowlist;
named MD instructions remain authoritative for the next model request. Clones
are independent, mode-0600 Pi session files in the session directory and remain
as normal history after completion/shutdown, including failed startup attempts.
They may contain sensitive parent conversation data and add model context cost;
enable inheritance only when needed. History is local-file data, not task IPC,
so it is not subject to the 64 KiB command limit.

Only supported frontmatter fields are read. Unknown fields, including reference
fields such as `extensions`, `skills`, `max_turns`, `memory`, and `isolation`, are
ignored and cannot activate those capabilities. Values of supported fields and
YAML syntax are still validated. Agent files and complete task IPC frames each
have a 64 KiB limit.

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

Every worker explicitly loads this shared list alongside its bridge. The list
replaces the defaults as a whole: `[]` loads only the bridge. It controls **which
extension code is loaded**, while each agent's `tools` selects **which tools are
enabled**; loading codemode does not automatically activate it. Agent Markdown
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

## Real Herdr verification

The opt-in integration script invokes real authenticated Pi/Codex models and
creates/cleans up only owned Herdr terminals and views. It is not part of CI:

```sh
PI_KITS_HERDR_LIVE=1 npm run test:herdr --workspace pi-subagent
```

If npm's augmented PATH resolves an older Codex installation, select the tested
binary explicitly with `PI_KITS_CODEX_BIN=/absolute/path/to/codex`. The script
checks Pi execution, Codex results, history-preserving continuation, live steer,
confirmed interruption, native TUI interaction, detach/ownership protection,
and managed continuation after exiting the TUI. Successful completion prints
`HERDR_LIVE_OK`. This uses model quota; normal `npm test` uses isolated fakes.

## Configuration compatibility and source references

Top-level `subagent` settings override the same legacy `workflow.subagent`
fields; unspecified fields retain legacy values before defaults are applied.
Legacy `workflow.enabled: false` disables subagents unless top-level
`subagent.enabled` explicitly overrides it. Prefer the independent top-level settings.
Configuration is validated by [the shared schema](../../../shared/config/schema.ts)
and resolved by [the shared config reader](../../../shared/config/index.ts).

Implementation references: [tools and lifecycle](../index.ts),
[task/session management](../manager.ts), [worker bridge](../runtime/pi/worker.ts),
[agent definitions](../agents.ts), [context cloning](../runtime/pi/clone.ts), and
[extension source resolution](../runtime/pi/extensions.ts).
