import { execFileSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

// ── Platform detection ────────────────────────────────────────────────

const platform = process.platform; // "linux" | "darwin" | "win32"

let isWsl = false;
if (platform === "linux") {
  try {
    const procVersion = readFileSync("/proc/version", "utf-8");
    isWsl = /microsoft|WSL|microsoft/i.test(procVersion);
  } catch {
    // not WSL
  }
}

// ── Helpers ────────────────────────────────────────────────────────────

export function isUrl(input: string): boolean {
  try {
    new URL(input);
    return true;
  } catch {
    return false;
  }
}

function toWindowsPath(linuxPath: string): string {
  return execFileSync("wslpath", ["-w", linuxPath], {
    encoding: "utf-8",
  }).trim();
}

/** Resolve input to an absolute path (URLs pass through unchanged). */
export function resolveTarget(raw: string, cwd: string): string {
  const trimmed = raw.trim().replace(/^@+/, "");
  if (isUrl(trimmed)) return trimmed;
  if (trimmed.startsWith("~")) return trimmed.replace(/^~/, homedir());
  if (trimmed.startsWith("/")) return trimmed;
  return resolve(cwd, trimmed);
}

type OpenResult = { ok: boolean; message: string };

/** Observe asynchronous spawn failures before reporting a successful launch. */
export function launchDetached(
  command: string,
  args: string[],
  spawnProcess: typeof spawn = spawn,
): Promise<OpenResult> {
  return new Promise((resolveResult) => {
    try {
      const child = spawnProcess(command, args, {
        detached: true,
        stdio: "ignore",
      });
      child.once("error", (error) =>
        resolveResult({
          ok: false,
          message: `Failed to open: ${error.message}`,
        }),
      );
      child.once("spawn", () => {
        child.unref();
        resolveResult({ ok: true, message: `Opened with ${command}` });
      });
    } catch (error) {
      resolveResult({
        ok: false,
        message: `Failed to open: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  });
}

/** Success means the opener launched, not that its application finished. */
export async function doOpen(target: string): Promise<OpenResult> {
  try {
    let cmd: string;
    let args: string[];

    if (platform === "darwin") {
      // macOS
      cmd = "open";
      args = [target];
    } else if (platform === "win32") {
      // Windows native
      cmd = "cmd";
      args = ["/c", "start", "", target];
    } else if (isWsl) {
      // WSL — open directly with Windows cmd.exe
      const winPath = target.startsWith("/") ? toWindowsPath(target) : target;
      return await launchDetached("cmd.exe", ["/c", "start", "", winPath]);
    } else {
      // Linux — use xdg-open
      return await launchDetached("xdg-open", [target]);
    }

    // macOS / Windows native
    return await launchDetached(cmd, args);
  } catch (err: unknown) {
    return {
      ok: false,
      message: `Failed to open: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
