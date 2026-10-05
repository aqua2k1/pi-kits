import { type ChildProcess, fork } from "node:child_process";

/** Own the backend through IPC, not the lifetime of the Pi event loop. */
export function spawnCodexGuardian(
  executable: string,
  argv: string[],
  cwd: string,
): ChildProcess {
  // Node has no Windows Job Object API. Do not silently weaken ownership.
  if (process.platform === "win32")
    throw new Error("Codex guardian requires POSIX process groups");
  const guardian = fork(new URL("./codex-guardian.mjs", import.meta.url), [], {
    cwd,
    detached: true,
    execArgv: [],
    stdio: ["ignore", "ignore", "pipe", "ipc"],
    env: { ...process.env, PI_KITS_SUBAGENT_WORKER: "1" },
  });
  // A real SIGKILL of the guardian would remove the resource owner. Keep the
  // ChildProcess interface used by cleanup, but route termination through IPC.
  guardian.kill = (signal = "SIGTERM") => {
    if (guardian.exitCode !== null || guardian.signalCode !== null)
      return false;
    if (signal !== "SIGTERM" && signal !== "SIGKILL") return false;
    if (!guardian.connected) return false; // disconnect already triggers cleanup
    guardian.send({ type: "stop", force: signal === "SIGKILL" }, () => {});
    Object.defineProperty(guardian, "killed", { value: true });
    return true;
  };
  guardian.send({ type: "start", executable, argv }, (error) => {
    if (error && guardian.connected) guardian.disconnect();
  });
  return guardian;
}
