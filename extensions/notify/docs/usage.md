# 桌面通知

## Pure notification API

Import the library, not the notification extension entry:

```ts
import { notify } from "@pi-kits/shared/notifications";
// Or from the repository: import { notify } from "./shared/notifications/index.ts";

notify("Build", "The build finished.");
```

`notify(title, msg)` has no Pi runtime dependency. Importing it does not register
commands, flags or lifecycle handlers, schedule timers, or launch processes.
Calling it returns `true` when the platform command was accepted for execution;
delivery is best-effort, so missing dependencies or OS failures never affect Pi.

Architecture:

- `shared/notifications/index.ts`: shared `notify` API.
- `shared/notifications/core.ts`: platform detection and shell-free launching.
- `shared/notifications/scripts/`: platform adapters, resolved relative to the
  library through `import.meta.url`, independent of the working directory.
- `extensions/notify/index.ts`: Pi lifecycle wiring only.

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
