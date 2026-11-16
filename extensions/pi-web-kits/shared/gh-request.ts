import { spawn } from "node:child_process";
import { MAX_GITHUB_COMMAND_OUTPUT_BYTES } from "./limits.ts";

type CommandResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  notFound: boolean;
  timedOut: boolean;
  aborted: boolean;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
};

type GhRequestOptions = {
  timeoutMs: number;
  signal?: AbortSignal;
  /** Fixed JSON media type for search excerpts; arbitrary headers are not accepted. */
  accept?: "application/vnd.github.text-match+json";
  /** Internal effect seam; production uses node:child_process. */
  spawn?: typeof spawn;
};

export class GhRequestError extends Error {
  constructor(
    readonly code:
      | "status"
      | "auth"
      | "request"
      | "network"
      | "rate-limit"
      | "tool-unavailable"
      | "timeout"
      | "cancelled"
      | "invalid-response",
    readonly status?: number,
  ) {
    super(`GitHub request failed: ${code}.`);
    this.name = "GhRequestError";
  }
}

function checkCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new GhRequestError("cancelled");
}

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

function execute(
  endpoint: string,
  options: GhRequestOptions,
): Promise<CommandResult> {
  return new Promise<CommandResult>((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = (options.spawn ?? spawn)(
        "gh",
        [
          "api",
          "--method",
          "GET",
          "--hostname",
          "github.com",
          ...(options.accept ? ["--header", `Accept: ${options.accept}`] : []),
          endpoint,
        ],
        {
          env: { ...process.env, GH_PROMPT_DISABLED: "1" },
          detached: process.platform !== "win32",
          stdio: ["ignore", "pipe", "pipe"],
          shell: false,
        },
      );
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
        MAX_GITHUB_COMMAND_OUTPUT_BYTES,
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
        16 * 1_024,
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
    if (options.signal?.aborted) onAbort();
  });
}

export async function ghRequest(
  endpoint: string,
  options: GhRequestOptions,
): Promise<unknown> {
  checkCancelled(options.signal);
  // Only relative REST paths: gh accepts absolute URLs despite --hostname.
  if (
    (options.accept !== undefined &&
      options.accept !== "application/vnd.github.text-match+json") ||
    !/^[A-Za-z0-9]/.test(endpoint) ||
    /[^A-Za-z0-9_./?%=&~+,!()*'-]/.test(endpoint)
  ) {
    throw new GhRequestError("request");
  }
  let result: CommandResult;
  try {
    result = await execute(endpoint, options);
  } catch (error) {
    checkCancelled(options.signal);
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      throw new GhRequestError("tool-unavailable");
    }
    throw new GhRequestError("network");
  }
  checkCancelled(options.signal);
  if (result.aborted) throw new GhRequestError("cancelled");
  if (result.timedOut) throw new GhRequestError("timeout");
  if (result.notFound) throw new GhRequestError("tool-unavailable");
  if (result.stdoutTruncated) throw new GhRequestError("invalid-response");
  if (result.code !== 0) {
    const status = Number(/\bHTTP\s+(\d{3})\b/i.exec(result.stderr)?.[1]);
    if (
      status === 429 ||
      (status === 403 && /rate limit/i.test(result.stderr))
    ) {
      throw new GhRequestError("rate-limit", status);
    }
    if (status) throw new GhRequestError("status", status);
    const auth =
      result.code === 4 ||
      /gh auth login|GH_TOKEN|authentication/i.test(result.stderr);
    throw new GhRequestError(auth ? "auth" : "request");
  }
  try {
    return JSON.parse(result.stdout) as unknown;
  } catch {
    throw new GhRequestError("invalid-response");
  }
}
