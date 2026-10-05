import { spawn } from "node:child_process";

// Plain Node entry point: no Pi API, TS loader, or parent's execArgv required.
// spawnCodexGuardian creates a dedicated session/process group. This guardian
// stays its leader until the final group SIGKILL, pinning the PGID against reuse.
// Backend/tool children inherit that group unless they explicitly escape it.
const GRACE_MS = 200; // Below CodexSession's existing 500ms cleanup deadline.
let started = false;
let stopping = false;
let timer;

function signalGroup(signal) {
  // Never target the parent's group or a recycled backend PID. The only group
  // we signal is named by our own, still-live PID (> 1).
  if (process.pid <= 1) process.exit(1);
  try {
    process.kill(-process.pid, signal);
  } catch {
    process.stderr.write("Codex guardian could not signal its process group\n");
    process.exit(1);
  }
}

function stop(force = false) {
  if (!started) process.exit(0); // No backend can exist before the start message.
  if (force) signalGroup("SIGKILL");
  if (stopping) return;
  stopping = true;
  // Keep this timer referenced even if the backend exits and its pipes close:
  // tool children can still be alive, including children which ignore SIGTERM.
  timer = setTimeout(() => signalGroup("SIGKILL"), GRACE_MS);
  signalGroup("SIGTERM"); // Includes us; the handler is deliberately idempotent.
}

// Without IPC this file must never launch a backend or signal any group.
if (!process.send || !process.connected || process.platform === "win32")
  process.exit(1);
process.on("disconnect", () => stop());
process.on("SIGTERM", () => stop());
process.on("SIGINT", () => stop());
process.on("SIGHUP", () => stop());
process.on("message", (message) => {
  if (message?.type === "stop") {
    stop(message.force === true);
    return;
  }
  if (message?.type !== "start" || started || stopping) return;
  if (!process.connected) {
    stop();
    return;
  }
  if (
    typeof message.executable !== "string" ||
    !Array.isArray(message.argv) ||
    !message.argv.every((arg) => typeof arg === "string")
  ) {
    stop();
    return;
  }
  started = true;
  try {
    const backend = spawn(message.executable, message.argv, {
      // Not detached: backend and ordinary tool descendants belong to our
      // isolated group, never the Pi process group. No IPC fd is passed down.
      detached: false,
      stdio: ["ignore", "ignore", "inherit"],
    });
    backend.once("error", () => {
      process.stderr.write("Codex guardian could not start app-server\n");
      stop();
    });
    // exit, not close: surviving tools may keep inherited stderr open forever.
    backend.once("exit", () => stop());
  } catch {
    process.stderr.write("Codex guardian could not start app-server\n");
    stop();
  }
});
process.on("exit", () => clearTimeout(timer));
