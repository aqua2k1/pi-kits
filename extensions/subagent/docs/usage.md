# Subagent usage

See the [package overview](../README.md) for architecture and minimal configuration.
See [Subagent configuration](configuration.md) for extension settings, agent fields,
runtime options, precedence, and defaults.
For layer interfaces, implementation contracts, and adapter integration, see
[Architecture and implementation contracts](architecture.md).

- [Herdr subagents](#herdr-subagents)
- [Runtime configuration](#runtime-configuration)
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
user Markdown files. Native sessions are named at creation as
`Sub · <agent type or -> · <initial description>` (for example,
`Sub · explorer · Inspect auth`). Resuming may change the displayed task
description but does not rename the native session. This first version does not
support scheduling or worktrees. Herdr workspace labels use
`sub-<agent type>-<full UUID>`, or `sub-anonymous-<full UUID>` when no type is
selected; these are separate from native session names.

Configure `<agent-dir>/pi-kits.json` (normally `~/.pi/agent/pi-kits.json`,
honoring `PI_CODING_AGENT_DIR`, including `~` expansion) and `/reload`:

```json
{
  "subagent": { "mux": "herdr", "enabled": true, "maxConcurrent": 4 }
}
```

Settings, defaults, activation requirements, and environment variables are detailed
in [Extension settings](configuration.md#extension-settings). Results and session files survive runtime
release; terminals remain inspectable only while retained by an open native view
or `keep_alive: true` (see [Automatic runtime release](#automatic-runtime-release)). Activation requires
`subagent.enabled`, explicit `mux: "herdr"`, and
exactly `HERDR_ENV === '1'`. There is no environment probing, automatic mux
selection, or fallback. If unconfigured, disabled, or outside that Herdr
environment, the entry registers no tools, hooks, or commands.

| Tool | Purpose |
| --- | --- |
| `subagent` | Start an ad-hoc task or select a user-defined agent type. |
| `resume_subagent` | Continue a finished task in its retained runtime session/history. |
| `list_subagent_types` | Discover user-defined agents and their source/configuration. |
| `get_subagent_result` | Retrieve managed task status, the latest settled reply and its source/revision/time, and live session state. |
| `steer_subagent` | Send guidance to a running task. |
| `stop_subagent` | Cancel a queued or running task. |

Use `/subagent:views <id> open` to open a view attached to an existing Pi
terminal. Placement is automatic: the first view opens right of the parent Pi,
and each subsequent view opens below the last surviving view, forming a right-side
column. There is no direction picker or right/down command argument. This policy
belongs to the shared subagent manager and applies to every mux adapter; adapters
only execute the supplied placement instruction. Concurrent opens are serialized
across agents. Closing a view does not cancel a running task; a finished task
releases its runtime unless `keep_alive` is true.
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
`close` command above to detach a view without canceling its running task.
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
active or queued, independently of the views panel. It uses the shared rounded
widget frame with dim borders and consistently muted tree branches; below 24
columns it falls back to an unbordered heading. Height is bounded to 12 lines
(11 without borders). It shows state, current tool
activity, elapsed time, assistant turns, tool calls, cumulative tokens, context
percentage (when available), and compactions. Tokens exclude repeated cache-read
prefixes. Up to four active tasks are expanded; additional active/queued tasks
are summarized to bound widget height. Completed rows linger for five seconds;
disconnected cleanup errors remain visible until resolved. Results remain available
after rows disappear; runtime retention follows the policy below. Shutdown/reload removes the widget and
its refresh timer.

Task and session states are separate: `status` remains the last managed task's
state; `result` is the latest settled reply from managed or user interaction.
`resultSource` is `managed` or `user_interaction`, `resultRevision` increases
for each published reply, and `resultUpdatedAt` is a Unix timestamp in milliseconds.
`resultOutcome` and optional `resultError` describe that reply independently of
the managed task's `status` and `error`. `sessionState` is `idle`, `running` (managed execution),
`interactive` (native/user execution without an active managed task),
`disconnected`, or `closed`. Native guidance during a managed run remains part
of that managed batch. Session state is absent
before a worker connects. Opening a view does not make a session interactive.
Native conversations update session activity through IPC and remain visible in
the widget until Pi settles, including retries and continuations. Each settled
native interaction updates `result` and sends a visible notification into the
parent's context without waking or interrupting it. Intermediate replies are not
published. Native interactions do not change managed task status, round or
statistics, emit another task-completion notification, or acquire a managed
concurrency slot. Opening a view alone does not publish an update. An IPC task
cannot take over native work.

Replies are limited to 64 KiB of UTF-8, safely truncated with `truncated: true`.
Cancellation/failure updates include their outcome; if no reply was produced,
the previous result and its metadata remain intact. The manager retains only the
latest reply, while session files retain conversation history. Native conversations
are shared with the parent: their notifications accumulate in its context and
consume tokens just like managed completion notifications.
### Automatic runtime release

A finished managed task (`completed`, `stopped`, or `error`) automatically releases
its runtime when no native view is open and `keep_alive` is false. Results, manager
records, and session files are retained; `get_subagent_result` continues to work.
Released sessions have `sessionState: "closed"` and cannot resume or open a native
view. A view must already be open (or opening) when the task finishes to retain it.
Closing a view during execution does not cancel the task; it releases on completion.
Closing the last view after completion releases the runtime, including views closed
outside the extension.

Set `keep_alive: true` on the initial `subagent` call or agent frontmatter only when
later resume is needed. It defaults to false and is fixed for the session, including
resumed rounds. Explicit frontmatter values, including false, override the call.
A keep-alive runtime remains owned until user deletion or parent shutdown, regardless
of whether any view is open. Opening the `/subagent:views` management panel alone is
not a native attachment and does not retain runtimes.

Use `resume_subagent` with `agent_id`, a new `prompt` (or an explicit
`runtime_config.review_target` for native review), optional `description`,
`runtime_config`, and `run_in_background`. It keeps the same ID, process,
terminal, view, session file/history (including native conversations), and
original agent instructions. Agent files are not re-read. Runtime task settings
reset on every round; no review target is inherited. The retained runtime's own
session settings cannot change on resume, although redundant values that
normalize identically to the retained configuration are allowed. Unknown and
foreign extras are ignored, even when their values are malformed. Pi tool and
prompt-mode configuration is applied once at session creation, not reapplied or
mutated per round. The
worker's current model/thinking/tool settings are not reset, so native user
changes remain in effect; requested agent tools must still be available as with
spawn. Omitted description retains the current task name.
The original agent's `run_in_background` setting takes precedence; otherwise
resume defaults to background, just like spawn.

Resume requires a finished managed task and an idle, retained, connected worker;
completed, cooperatively stopped, and errored rounds may resume only while retained
by `keep_alive` or an open native view. Interactive,
active, closed, or disconnected sessions are rejected without replacing their
results. No process is restarted. Each accepted resume increments `round` and
resets the managed error, per-round usage, task timestamps, waiter claims, and
completion notification. The latest reply and its metadata remain available until
a newer reply is published. Earlier results remain in tool history and Pi's session
file. Foreground waits are bound to their round even if another round starts.

Resumed rounds enter the same FIFO concurrency queue as new tasks. If native
work starts while queued, dispatch fails rather than taking over the user.
The worker checks idle at receipt and again before submission after async auth
preflight; native startup invalidates any pending reservation. Canceling
a queued/preflight resume never aborts native work. All workers, including native/user sessions, remain owned by the parent agent.
Control-connection loss closes the runtime and its views even when a resumed
round has not acknowledged receipt. Unresponsive managed cancellation also
closes the runtime after its timeout. The concurrency claim is released only
after cleanup succeeds; failed cleanup retains ownership for retry.

`stop_subagent` cancels the managed task, not independent native/user work. After
cooperative cancellation, the same automatic release policy applies;
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

## Runtime configuration

Runtime fields, defaults, precedence, and spawn/resume rules are documented in
[Runtime configuration](configuration.md#runtime-configuration).

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
Codex ignores Pi-only `runtime_config` fields (`tools`, `disallowed_tools`,
`prompt_mode`, and `inherit_context`), including explicit `inherit_context: false`
and malformed values. It never interprets them. Context cloning is unsupported:
no Pi transcript is converted or copied into Codex. The extension allowlist applies
only to Pi.

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
including a `codex` block or top-level `runtime_args`, `tools`,
`disallowed_tools`, `prompt_mode`, or `inherit_context`, are ignored by the generic
parser, even if their values are malformed. Each runtime reads and validates
only its own `runtime_config` fields; unknown and foreign fields are ignored.
Internal trusted `ManagerOptions` launch/deployment injection is unchanged;
it is not exposed as agent frontmatter or tool-call configuration.
Approval and user-input requests during headless managed execution are not
automatically granted. Runtime names are resolved by the runtime registry at
launch.

Native Codex TUI views are created lazily on demand, including while a managed
task is running, using `codex --remote … resume <thread-id>` against the same
app-server. They are writable, not screen-scraped viewers. Attachment waits for
the managed `turn/start` or `review/start` to settle; opening/focusing/detaching a pane never
cancels or relinquishes that managed turn. Native input may steer or interrupt
it, and its terminal event still determines the managed result. Independent
native turns update the latest reply independently of managed task completion and never get canceled by
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

A named `.pi/agent/agents/reviewer.md` can declare Codex session options as CSV
or a YAML array under `runtime_config.runtime_args`:

```markdown
---
runtime: codex
runtime_config:
  runtime_args: review, search
model: gpt-6.1-sol
thinking: medium
description: Critical code review subagent
---
Review correctness, necessity, and better alternatives.
```

`runtime_args: [review, search]` inside `runtime_config` is equivalent. The
common agent parser retains the generic configuration record; the selected
runtime's pure parser interprets only its own fields. Pi ignores
`runtime_config.runtime_args`, even if malformed; top-level `runtime_args` is
ignored by the generic parser and must be moved into `runtime_config` to take
effect for Codex.
The Codex adapter interprets `review` and `search` and forwards
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

For an unnamed Codex reviewer, pass both session and task settings to `subagent`:

```json
{
  "runtime": "codex",
  "description": "Review changes against main",
  "runtime_config": {
    "runtime_args": "review",
    "review_target": { "type": "baseBranch", "branch": "main" }
  }
}
```

For the named `reviewer` above, its Markdown supplies the session's
`runtime_config.runtime_args`; the call supplies only the task's target:

```json
{
  "subagent_type": "reviewer",
  "description": "Review changes against main",
  "runtime_config": {
    "review_target": { "type": "baseBranch", "branch": "main" }
  }
}
```

For repeated review, set `keep_alive: true` on the initial call (or keep its native
view open), then specify the review scope again on every `resume_subagent` call:

```json
{
  "agent_id": "<agent-id>",
  "runtime_config": {
    "review_target": { "type": "uncommittedChanges" }
  }
}
```

`runtime_config.review_target` supports:

- `{ "type": "uncommittedChanges" }`: staged, unstaged and untracked changes.
- `{ "type": "baseBranch", "branch": "main" }`: changes against a base branch.
- `{ "type": "commit", "sha": "<SHA>", "title": null }`: one commit; title is optional.
- `{ "type": "custom", "instructions": "Review authentication for security issues" }`.

Review mode requires an explicit target; it is never guessed or reused from a
previous round. It is a call-only task setting: agent frontmatter and session
configuration ignore `runtime_config.review_target`, even if malformed, and never
supply or inherit a target. Every native-review call requires a fresh target.
Codex validates the call's target and rejects it for non-review tasks. Pi ignores
this foreign field, including malformed values. Top-level `review_target` is
ignored; it is not a supported tool parameter or compatibility alias.
Omit `prompt` for structured targets: the native review protocol cannot carry
an additional task prompt. For a custom target, an optional call-level `prompt`
is appended to its instructions. Ordinary tasks still require a nonempty prompt.
Native review uses Codex's own review rubric and clears the thread's developer
instructions; the agent Markdown body is not automatically copied into a custom
review target. Put explicit review requirements in the custom target's
`instructions`. Codex's own `review_model` configuration may also override the
thread model; this adapter does not override that native policy. Review results
are collected from native `exitedReviewMode.review` items, including paginated
completion hydration.

## User-defined agent types

Agent directories, discovery/override rules, frontmatter fields, Pi prompt modes,
and examples are documented in
[User-defined agent types](configuration.md#user-defined-agent-types).
Use `list_subagent_types` to discover enabled types, then pass `subagent_type` to
`subagent`; omitting it creates an ad-hoc task.

## Parent context cloning

For Pi only, set `runtime_config.inherit_context: true` in frontmatter or pass
`"runtime_config": { "inherit_context": true }` to `subagent`. The Pi adapter owns
validation and context capture through `runtime.prepareSpawn`; the tool entry
point only forwards opaque host context. Frontmatter takes precedence; `false`
starts a fresh child session. Codex ignores this foreign field, even if malformed,
without interpreting it or capturing context. Pi freezes the parent's current
branch before queueing. An independent SessionManager uses Pi's native
branch-cloning logic, then the child CLI opens
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

Supported generic fields and YAML syntax remain validated. Unknown frontmatter
fields (such as `extensions`, `skills`, `max_turns`, `memory`, and `isolation`)
are ignored. Runtime fields, ignore rules, precedence, and session/task inheritance
are defined in [Runtime configuration](#runtime-configuration).
Agent files and complete task IPC frames each have a 64 KiB limit.

## Worker extension allowlist

Extension source syntax, named package selections, path resolution, and loading
policy are documented in
[Worker extension allowlist](configuration.md#worker-extension-allowlist).
The list selects loaded Pi extension code; `runtime_config.tools` separately
selects enabled tools. Neither policy is an OS sandbox.

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

Legacy settings precedence, validation, and configuration implementation references
are documented in [Configuration compatibility](configuration.md#configuration-compatibility-and-source-references).

Developer contracts: [architecture and implementation guide](architecture.md).
Implementation references: [tools and lifecycle](../index.ts),
[task/session management](../manager.ts), [worker bridge](../runtime/pi/worker.ts),
[agent definitions](../agents.ts), [context cloning](../runtime/pi/clone.ts), and
[extension source resolution](../runtime/pi/extensions.ts).
