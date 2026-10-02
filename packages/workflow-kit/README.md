# pi-workflow-kit

A Pi package containing two explicit extension entries:

- `src/extensions/commit/index.ts`: `/commit` and `--commit`.
- `src/extensions/notify/index.ts`: idle TUI completion notifications.

## Load

```sh
pi -e ./packages/workflow-kit
# Or persist a local package installation:
pi install ./packages/workflow-kit
```

Disable the original `commit` and `notify` extensions before loading this package
alongside them, to avoid duplicate command/flag registrations and completion
notifications. The source implementations are not changed by this package.

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

## Configuration

Use the `workflow` section of agent-dir `pi-kits.json`; edit then `/reload`.
`enabled` disables the kit, while `commit.enabled` and `notify.enabled` gate
individual entries. `commit.model` sets the first picker option, ahead of model
memory and the current model; `thinking` and `timeoutMs` configure generation.
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
