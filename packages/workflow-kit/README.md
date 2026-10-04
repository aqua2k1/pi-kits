# pi-workflow-kit

A Pi package containing four explicit extension entries:

- `src/extensions/commit/index.ts`: `/commit` and `--commit`.
- `src/extensions/notify/index.ts`: idle TUI completion notifications.
- `src/extensions/ask-user-question/index.ts`: `ask_user_question` tabbed terminal
  questionnaire and native RPC dialogs.
- `src/extensions/subagent/index.ts`: opt-in Herdr background tasks and terminal
  views. `src/extensions/subagent/worker.ts` is a worker bridge loaded only via
  explicit `-e`, not a manifest entry.

## Load

```sh
pi -e ./packages/workflow-kit
# Or persist a local package installation:
pi install ./packages/workflow-kit
```

Disable the original `commit` and `notify` extensions before loading this package
alongside them, to avoid duplicate command/flag registrations and completion
notifications. The source implementations are not changed by this package.

## User questions (MVP)

`ask_user_question` asks single-choice or multi-select questions in a fixed lower-half terminal
panel. Editor-style rules use Pi's active theme; the upper half stays visible.
The non-overlay panel temporarily replaces Pi's editor. Pi lays out the transcript
above the dock and keeps ownership of the surrounding footer, notifications and
widgets; small terminals may shrink or clip these regions. Closing restores the
editor, its draft, and focus.
Every row is filled to the panel width so underlying content cannot show through.
Short questionnaires leave blank space; input and footer stay at the bottom.
Long option lists scroll.
Use Left/Right or Tab/Shift+Tab to switch questions and revisit answers. Each
question keeps its selected option and custom-answer draft. Confirm answers with
Enter, then review from the Submit tab. It has separate Submit and Cancel
buttons: Up/Down chooses a button, Enter activates it, and fullscreen mouse clicks
activate buttons directly. PgUp/PgDn browses the reviewed answers independently
of button focus. All questions must be answered before Submit succeeds; Cancel
is always available. Esc cancels; earlier answers remain in `details` but are not a
completed submission. Cancellation returns only `User cancelled` in the tool text;
the structured `details` still carries `cancelled: true` and any earlier answers.

In Pi's fullscreen terminal mode, tabs can also be clicked with the mouse. Regular
terminal mode leaves mouse input to the terminal, so use keyboard navigation there.
Enable fullscreen using Pi's `tuiMode: "fullscreen"` setting if needed; this is a Pi
setting, not a `pi-kits.json` option. RPC uses native select/input dialogs sequentially
and does not support tabs or review. Shift+Up/Down scroll long question details;
The panel owns keyboard input while open. While typing a
custom answer, use Ctrl+B/F or Home/End to move the cursor.

There are no upper limits on question counts, option counts, or text lengths; each
call needs at least one question and each question at least one option. A custom
answer row is appended automatically. Blank custom answers cannot be confirmed.

Set `multiSelect: true` on a question to show checkboxes. Space toggles the focused
option, while Enter confirms all checked options and advances. At least one option
must be checked. Checks survive switching tabs and can be revised. A custom answer
replaces the checkbox answer rather than combining with it; Space types normally
inside the custom-answer editor. Single-select remains the default.

RPC multi-select uses a native input dialog: enter option numbers such as `1,3`
or a custom answer. Invalid numeric selections and blank input are retried.
Use `text: 123` to submit a numeric custom answer rather than option numbers.

```json
{
  "questions": [
    {
      "question": "Which cache should we use?",
      "options": [
        { "label": "Memory (Recommended)", "description": "No infrastructure" },
        { "label": "Redis", "description": "Shared across instances" }
      ]
    }
  ]
}
```

The tool declares documented input and output JSON schemas. Structured results
are returned in `structuredContent` as well as `details`; successful tool text
still includes the answers, and cancellation text remains `User cancelled`.

Results include `answers` and `cancelled`; each answer includes `questionIndex`,
`question`, `kind` (`option`, `custom`, or `multi`), and `answer`. Option answers
also include `optionIndex`. Multi-select answers include `selected` labels and
zero-based `optionIndices`, so duplicate labels are unambiguous. Non-interactive
runs hide the tool. Execution is sequential and respects abort signals. This MVP
has no previews or notes.

Disable other extensions registering `ask_user_question` (including
`rpiv-ask-user-question`) before loading this entry. Set
`workflow.askUserQuestion.enabled: false` to disable it independently.

### Question lifecycle hooks

The question extension emits hooks through `pi.events`:

- `workflow:ask-user-question:start`: immediately before dialog interaction.
- `workflow:ask-user-question:end`: after answering, cancelling, aborting, or
  a dialog error.

Both payloads include `toolCallId`, `mode`, and `questionCount`. The end hook
also includes `status` (`answered`, `cancelled`, `aborted`, or `error`);
answered/cancelled events include `result`. Calls without UI or already aborted
before interaction emit neither hook. Constants and payload types live in
`src/extensions/ask-user-question/events.ts`.

The question extension itself sends a best-effort desktop notification,
`Pi: Waiting for your answer.`, when TUI interaction begins. It uses the shared
notification transport, requires no notify extension to be loaded, and respects
`workflow.notify.enabled`. RPC interactions emit hooks but do not send desktop
notifications. Closing the questionnaire emits the end hook without another
desktop notification.

TUI-only panel notifications are separate from tool start/end:

- `workflow:ui:opened`: the shared session created the component inside
  `ui.custom`'s factory, before returning it to Pi. Pi has no post-mount callback:
  this is an opening notification, **not proof of mounting or first paint**.
- `workflow:ui:closed`: once the host promise settles and the abort listener and
  component resources are cleaned up. Its `status` is `completed`, `cancelled`,
  `aborted`, or `error` (`completed` corresponds to tool status `answered`).

Both include `panelId: "ask-user-question"` and `instanceId` (the tool call ID).
The order for an opened TUI interaction is tool start, panel opened, panel closed,
then tool end. No panel events are emitted for RPC, a host failure before factory
creation, or an abort observed before opening. An opened interaction gets one
closed notification even on errors. Constants/types are exported from
`pi-workflow-kit/ui/docked-panel`. Entry-point callbacks emit through `pi.events`;
the shared layer does not subscribe to Pi events. Opened-callback failures still
attempt closed after cleanup. The original interaction/factory/cancellation error
wins over disposal and closed-callback errors; disposal errors reject only when
there is no original failure, and closed-callback errors only when neither has
failed. If abort cancellation throws, the session retains that error and calls
Pi's factory completion callback to settle/restore the host before rejecting,
not a competing rejection that could leave the panel mounted. Closed status is
`aborted` whenever the signal is aborted, including cancellation/disposal failures;
the rejection still preserves the original error identity.

## Shared terminal UI

Reusable UI lives in `src/lib/ui/`, independently of the tool schema and
extension registration:

- `pi-workflow-kit/ui/tabs`: `layoutTabs(labels, active, width)` and `tabAt`
  provide a bounded tab viewport and component-local mouse hit testing.
- `pi-workflow-kit/ui/panel`: `fillPanel` and `panelRule` provide opaque
  padded frames, pinned footer rows, and width-safe rules.
- `pi-workflow-kit/ui/docked-panel`: the fixed half-screen editor-dock design:
  `layout.ts` owns height, compact thresholds, title/detail/list budgeting and
  scrolling windows; `frame.ts` owns the themed titled top boundary, separate
  navigation row, uninterrupted bottom boundary, standalone muted shortcut row,
  compact content priorities, padding, and pinned control hit rectangles.
  `session.ts` owns non-overlay `ui.custom`, abort completion, listener removal,
  and exactly-once component disposal across host and fallback cleanup.
  `events.ts` defines optional opened/closed callbacks and adapter event payloads.

These modules do not register tools, commands, or lifecycle handlers. This is a
small fixed design for the questionnaire's needs, not a configurable UI framework.
Tabs disappear below seven panel rows, shortcuts below nine. Six-row review keeps
its title, answer and two controls; tiny panels underline their last row instead
of sacrificing the title or active input to a bottom rule.

Questionnaire data, state transitions, keys, question/option text, tab labels,
review/confirmation, and custom `Input` focus/IME handling remain in
`src/extensions/ask-user-question/ui/`. `tui.ts` adapts those to the shared session;
`index.ts` wires callbacks to `pi.events`. `core.ts` owns schemas, answer types,
answer construction and native non-TUI dialogs. UI depends on the business core
and shared design primitives, not the other way around. Shared files are library
exports only, never Pi extension manifest entries.

## Commit workflow

`/commit` lists and confirms staged files, chooses a model (a fuzzy picker in
TUI, plain selection in RPC), and generates a Conventional Commits message using
a tool-less `pi -p` child process. Review the generated message, regenerate it,
cancel, or submit it with `git commit -m`.

`pi --commit` dispatches `/commit` only during startup. Pi shuts down only after
a successful startup-triggered commit; cancellations and failures do not exit.
Non-interactive modes do not execute the commit flow.

Model memory is stored in `workflow.commit.lastModel` inside
`<agent-dir>/pi-kits.json`, honoring `PI_CODING_AGENT_DIR` (including `~`
expansion). Updates preserve other configuration fields. Legacy
`extensions/commit/last_model.json` is ignored and never migrated or modified.

## Herdr subagents (MVP)

Subagents run general tasks in the background using Herdr's native Pi terminals
plus a worker bridge. The extension does not build its own PTY. Task parameters
include `model` and `thinking`, plus an optional named `subagent_type` backed by
user Markdown files. This first version does not support scheduling or worktrees.

Configure agent-dir `pi-kits.json` and `/reload`:

```json
{
  "workflow": {
    "subagent": { "mux": "herdr", "enabled": true, "maxConcurrent": 4 }
  }
}
```

Configuration is validated and defaulted through `@pi-kits/config`. `mux` accepts
only `"herdr"` and has no default; `enabled` defaults to `true`.
`maxConcurrent` limits executing tasks, not retained idle Pi terminals; it is an
integer from 1 to 32, defaulting to 4. Completed terminals remain available for
inspection until parent-session cleanup. Activation requires
`workflow.enabled`, `workflow.subagent.enabled`, explicit `mux: "herdr"`, and
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
opens the shared lower-half docked panel with live Agents/Actions tabs; passing
only an ID opens its actions directly. Up/Down selects, Enter confirms, Tab
switches tabs, Left returns to agents, and Esc closes the panel. Fullscreen mode
also supports mouse selection. Closing the panel does not affect workers.
Subagent task/control tool rows default to a compact task title, status, and
one-line result/error preview. IDs, paths, timestamps, counters, and full prompts/results appear only
when expanded with Ctrl+O. Rendering does not change tool data or JSON/print output.

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

Task and session states are separate: `status` remains the last managed task\'s
state/result; `sessionState` is `idle`, `running` (managed execution),
`interactive` (native/user execution without an active managed task),
`disconnected`, or `closed`. Native guidance during a managed run remains part
of that managed batch. Session state is absent
before a worker connects. Opening a view does not make a session interactive.
Native conversations update session activity through IPC and remain visible in
the widget until Pi settles, including retries and continuations. They do not
overwrite the managed result/statistics, emit another completion notification,
or acquire a managed concurrency slot. An IPC task cannot take over native work.
Use `resume_subagent` with `agent_id`, a new `prompt`, optional `description`,
and optional `run_in_background`. It keeps the same ID, process, terminal, view,
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
a queued/preflight resume never aborts native work. If cancellation or connection
loss occurs before the worker confirms ownership of a dispatched round, its
terminal is retained and the concurrency claim is held rather than killing
potential native work; parent shutdown/reload can clean up retained workers.

`stop_subagent` cancels the managed task, not independent native/user work, and
retains its terminal when Pi cooperates;
if cancellation does not settle within five seconds, the terminal is destroyed.
Parent session shutdown/reload cleans up owned workers and views. Workers share
the filesystem and credentials and are not a sandbox. They start with
`--no-approve`, so trust-gated project resources are not loaded automatically.
Workers also use `--no-extensions` and explicitly load the worker bridge plus
`workflow.subagent.extensionAllowlist`. Defaults are `builtin:codemode` and
`builtin:tool-search`; arbitrary parent/user extensions, including permission
extensions, are not inherited. Add trusted extensions to this list explicitly.

The worker bridge uses authenticated loopback TCP JSONL, not terminal screen
parsing. Command frames and returned results are bounded to 64 KiB; truncated
results identify the session file. State is session-scoped: cross-process task
recovery and automatic reconnect are not implemented. IPC loss during an
acknowledged active round triggers worker cleanup before releasing its queue
slot. Failed cleanup is reported as `disconnected`; use `stop_subagent` to
retry. Unacknowledged resumed rounds instead retain the worker and slot as
described above; finished sessions retain their last task result.

Only `src/extensions/subagent/index.ts` is listed in the root and workflow-kit
Pi manifests. The background Pi loads `src/extensions/subagent/worker.ts` via an
explicit `-e`; the worker is never auto-loaded as a package resource.

### User-defined agent types

There are **no embedded agent definitions or installed templates**. Create your
own Markdown files in these directories:

1. `<cwd>/.pi/agents/*.md` — project, highest priority.
2. `$PI_CODING_AGENT_DIR/agents/*.md` — global, normally `~/.pi/agent/agents/`.

The filename without `.md` is the type name, matching `gotgenes/pi-subagents`.
Names are resolved case-insensitively. A project file **replaces the entire**
same-name global definition, not individual fields; `enabled: false` can hide a
global type. Replaced global files are not read or validated. Duplicate names
within one directory are errors. Definitions are
read afresh when listing or spawning; editing a file affects new tasks, not
already queued/running tasks. Invalid definitions fail explicitly rather than
falling back to a less restricted global configuration.

For example, a user-created `.pi/agents/auditor.md` could contain:

```markdown
---
description: Review code for security issues
display_name: Auditor
model: anthropic/claude-sonnet-4-6
thinking: high
tools: read, grep, find, bash
disallowed_tools: edit, write
prompt_mode: replace
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
| `display_name` | Type name; shown beside the task in widgets/views. |
| `model` | Call parameter, then parent model. |
| `thinking` | Call parameter, then parent thinking level. |
| `tools` | Native Pi defaults; CSV or YAML array, `none`/empty disables all tools. Built-in and whitelisted extension tool names are accepted. |
| `disallowed_tools` | No additional denylist; CSV or YAML array of built-in tools. |
| `prompt_mode` | `replace`: body replaces the worker system prompt and context-file discovery is disabled. `append` appends to the worker's normal Pi prompt. |
| `enabled` | `true`; `false` disables selection. |
| `run_in_background` | Call parameter, then `true`. |

Configured model, thinking, and background mode take precedence over call
parameters. Thinking supports `off`, `minimal`, `low`, `medium`, `high`, `xhigh`,
and `max`. Tool names include Pi built-ins (`read`, `bash`, `edit`, `write`,
`grep`, `find`, `ls`, `powershell`), `codemode`, `tool_search`, and tools registered
by explicitly whitelisted extensions. A denylist is applied after the allowlist;
missing requested tools fail before a model turn instead of being silently
ignored. Codemode cannot use tools outside the CLI allowlist/denylist. Tool
selection is not a sandbox: `bash` can still change files.

The Markdown body is sent as bounded structured IPC, not substituted into shell
commands or interpreted as a filename. Its prompt remains active after completion
for native terminal interaction. Workers load the bridge and the shared extension
allowlist; `append` does not fork the parent conversation or inherit its extensions. Other
reference fields (`extensions`, `skills`, `max_turns`, `memory`, `isolation`,
`inherit_context`, etc.) are not implemented and are rejected, not silently
ignored. Agent files and complete task IPC frames each have a 64 KiB limit.

### Worker extension allowlist

Configure `workflow.subagent.extensionAllowlist` in agent-dir `pi-kits.json`:

```json
{
  "workflow": {
    "subagent": {
      "mux": "herdr",
      "extensionAllowlist": ["builtin:codemode", "builtin:tool-search"]
    }
  }
}
```

Every worker explicitly loads this shared list alongside its bridge. The list
replaces the defaults as a whole: `[]` loads only the bridge. It controls **which
extension code is loaded**, while each agent\'s `tools` selects **which tools are
enabled**; loading codemode does not automatically activate it. Agent Markdown
cannot add extensions. Add trusted extension files/directories explicitly for
custom tools; paths may be absolute, `~/...`, or relative to the agent directory
(not the task/project cwd). Built-in extension names use `builtin:<name>`; the
tool `tool_search` is provided by `builtin:tool-search`. Reload the parent after
changing the whitelist. Extensions run with full process permissions, so this
is a loading policy, not an OS sandbox.

## Configuration

Use the `workflow` section of agent-dir `pi-kits.json`; edit then `/reload`.
`enabled` disables the kit, while `commit.enabled`, `notify.enabled`,
`askUserQuestion.enabled`, and `subagent.enabled` gate individual entries.
Subagents additionally require an explicit mux and the Herdr environment above.
`commit.model` sets the first picker option, ahead of model memory and the current
model; `thinking` and `timeoutMs` configure generation.
`rememberModel: false` disables reading/writing `commit.lastModel`; the factory
still reads configuration to apply feature switches and generation settings.
`notify.quietPeriodMs` controls the idle delay (default 1000 ms); disabling notify
also suppresses commit's completion notification. The pure API remains independent
of configuration. See the [configuration example](../../pi-kits.example.json).

## Pure notification API

Import the library, not the notification extension entry:

```ts
import { notify } from "pi-workflow-kit/notifications";
// Within this package: import { notify } from "./src/lib/notifications/index.ts";

notify("Build", "The build finished.");
```

`notify(title, msg)` has no Pi runtime dependency. Importing it does not register
commands, flags or lifecycle handlers, schedule timers, or launch processes.
Calling it returns `true` when the platform command was accepted for execution;
delivery is best-effort, so missing dependencies or OS failures never affect Pi.

Architecture:

- `src/lib/notifications/index.ts`: shared `notify` API.
- `src/lib/notifications/core.ts`: platform detection and shell-free launching.
- `src/lib/notifications/scripts/`: platform adapters, resolved relative to the
  library through `import.meta.url`, independent of the working directory.
- `src/extensions/notify/index.ts`: Pi lifecycle wiring only.

The completion adapter uses the same API to send `Pi: Task completed.` only in
TUI after `agent_settled` has remained idle for the configured quiet period
(one second by default). Pending notifications
are cancelled on input, `before_agent_start`, `agent_start`, or session shutdown.
The idle state is checked again before delivery; notifier errors are contained.

### Platform adapters

| Environment | Adapter | Dependency | Behavior |
| --- | --- | --- | --- |
| Windows / WSL | `windows-toast.ps1` | Windows PowerShell | Expires after one minute. |
| Linux | `linux-notify.sh` | `notify-send` / libnotify | Expires after 60 seconds and replaces the previous notification. |
| macOS | `macos-notify.sh` | `terminal-notifier` | Removes the grouped notification after 60 seconds. |

Unix adapters receive title/message as positional arguments; the PowerShell
adapter receives `-Title` and `-Message`. WSL uses the Windows adapter through
interop. The Windows script selects a registered terminal AppUserModelID;
native Linux and macOS do not depend on a terminal emulator. All adapters use
stable replacement identifiers.

```sh
brew install terminal-notifier  # macOS
sudo apt install libnotify-bin # Linux
```

After changing package code, run `/reload` in Pi.

## Tests and quality checks

The root workspace supplies `tsx`, Pi host peer packages, and Biome:

```sh
npm test --workspace pi-workflow-kit
# From this package directory:
npm test
npx biome check .
# Only after the read-only check passes:
npx biome format --write .
```

The original commit core and notify transport/lifecycle tests are retained.
Additional tests cover commit registration/startup guards, executable adapter
paths, explicit manifest entries, and an isolated API import which rejects Pi
host packages and extension modules and traps notification timers/processes.
The tests never deliver real desktop notifications or commit the workspace.
