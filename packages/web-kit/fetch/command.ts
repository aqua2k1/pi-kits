import { spawn } from "node:child_process";
import { assertNotCancelled } from "./errors.ts";
import type { CommandResult, CommandRunner } from "./types.ts";

function terminate(child: ReturnType<typeof spawn>): void {
  if (child.pid && process.platform !== "win32") {
    try {
      process.kill(-child.pid, "SIGTERM");
      return;
    } catch {
      // The process may have exited between the check and kill.
    }
  }
  child.kill("SIGTERM");
}

function forceTerminate(child: ReturnType<typeof spawn>): void {
  if (child.pid && process.platform !== "win32") {
    try {
      process.kill(-child.pid, "SIGKILL");
      return;
    } catch {
      // The process may have exited between the check and kill.
    }
  }
  child.kill("SIGKILL");
}

function appendBounded(
  chunks: Buffer[],
  chunk: Buffer,
  current: number,
  limit: number,
): { size: number; truncated: boolean } {
  const remaining = limit - current;
  if (remaining <= 0) return { size: current, truncated: true };
  if (chunk.byteLength <= remaining) {
    chunks.push(chunk);
    return { size: current + chunk.byteLength, truncated: false };
  }
  chunks.push(chunk.subarray(0, remaining));
  return { size: limit, truncated: true };
}

export class ProcessCommandRunner implements CommandRunner {
  run(
    command: string,
    args: readonly string[],
    options: {
      cwd?: string;
      env?: NodeJS.ProcessEnv;
      signal?: AbortSignal;
      timeoutMs: number;
      maxStdoutBytes: number;
      maxStderrBytes: number;
    },
  ): Promise<CommandResult> {
    assertNotCancelled(options.signal);
    return new Promise<CommandResult>((resolve, reject) => {
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(command, [...args], {
          cwd: options.cwd,
          env: options.env ?? process.env,
          detached: process.platform !== "win32",
          stdio: ["ignore", "pipe", "pipe"],
          shell: false,
        });
      } catch (error) {
        reject(error);
        return;
      }

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let stdoutSize = 0;
      let stderrSize = 0;
      let stdoutTruncated = false;
      let stderrTruncated = false;
      let timedOut = false;
      let aborted = false;
      let settled = false;
      let timeoutTimer: NodeJS.Timeout | undefined;
      let killTimer: NodeJS.Timeout | undefined;
      let stopping = false;
      let onAbort = () => {};

      const cleanup = () => {
        if (timeoutTimer) clearTimeout(timeoutTimer);
        if (killTimer) clearTimeout(killTimer);
        killTimer = undefined;
        options.signal?.removeEventListener("abort", onAbort);
      };

      const finish = (result: CommandResult) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(result);
      };

      const stop = (reason: "timeout" | "abort" | "overflow") => {
        if (settled) return;
        if (reason === "timeout") timedOut = true;
        if (reason === "abort") aborted = true;
        if (stopping) return;
        stopping = true;
        terminate(child);
        killTimer = setTimeout(() => {
          killTimer = undefined;
          if (!settled) forceTerminate(child);
        }, 250);
      };

      onAbort = () => stop("abort");

      child.stdout?.on("data", (chunk: Buffer | string) => {
        const result = appendBounded(
          stdoutChunks,
          Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk),
          stdoutSize,
          options.maxStdoutBytes,
        );
        stdoutSize = result.size;
        if (result.truncated) {
          stdoutTruncated = true;
          stop("overflow");
        }
      });
      child.stderr?.on("data", (chunk: Buffer | string) => {
        const result = appendBounded(
          stderrChunks,
          Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk),
          stderrSize,
          options.maxStderrBytes,
        );
        stderrSize = result.size;
        if (result.truncated) stderrTruncated = true;
      });

      child.once("error", (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") {
          finish({
            code: null,
            signal: null,
            stdout: Buffer.concat(stdoutChunks).toString("utf8"),
            stderr: Buffer.concat(stderrChunks).toString("utf8"),
            notFound: true,
            timedOut,
            aborted,
            stdoutTruncated,
            stderrTruncated,
          });
          return;
        }
        if (!settled) {
          settled = true;
          cleanup();
          reject(error);
        }
      });

      child.once("close", (code, signal) => {
        finish({
          code,
          signal,
          stdout: Buffer.concat(stdoutChunks).toString("utf8"),
          stderr: Buffer.concat(stderrChunks).toString("utf8"),
          notFound: false,
          timedOut,
          aborted,
          stdoutTruncated,
          stderrTruncated,
        });
      });

      options.signal?.addEventListener("abort", onAbort, { once: true });
      timeoutTimer = setTimeout(() => stop("timeout"), options.timeoutMs);
    });
  }
}
