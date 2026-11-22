import { spawn } from "node:child_process";
import { isEnoentError } from "./guards.ts";
import { MAX_GITHUB_COMMAND_OUTPUT_BYTES } from "./limits.ts";

const TEXT_MATCH_ACCEPT = "application/vnd.github.text-match+json";
const MAX_GITHUB_STDERR_BYTES = 16 * 1_024;
const KILL_GRACE_MS = 250;

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
  accept?: typeof TEXT_MATCH_ACCEPT;
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

function signalChildProcess(
  child: ReturnType<typeof spawn>,
  signal: "SIGTERM" | "SIGKILL",
): void {
  if (child.pid && process.platform !== "win32") {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // The process may have exited between the check and kill.
    }
  }
  child.kill(signal);
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

function buildGhArgs(
  endpoint: string,
  accept?: typeof TEXT_MATCH_ACCEPT,
): string[] {
  return [
    "api",
    "--method",
    "GET",
    "--hostname",
    "github.com",
    ...(accept ? ["--header", `Accept: ${accept}`] : []),
    endpoint,
  ];
}

function isValidGhRequest(
  endpoint: string,
  accept: GhRequestOptions["accept"],
): boolean {
  // Only relative REST paths: gh accepts absolute URLs despite --hostname.
  return (
    (accept === undefined || accept === TEXT_MATCH_ACCEPT) &&
    /^[A-Za-z0-9]/.test(endpoint) &&
    !/[^A-Za-z0-9_./?%=&~+,!()*'-]/.test(endpoint)
  );
}

function classifyExitFailure(result: CommandResult): GhRequestError {
  const status = Number(/\bHTTP\s+(\d{3})\b/i.exec(result.stderr)?.[1]);
  if (status === 429 || (status === 403 && /rate limit/i.test(result.stderr))) {
    return new GhRequestError("rate-limit", status);
  }
  if (status) return new GhRequestError("status", status);
  const auth =
    result.code === 4 ||
    /gh auth login|GH_TOKEN|authentication/i.test(result.stderr);
  return new GhRequestError(auth ? "auth" : "request");
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
        buildGhArgs(endpoint, options.accept),
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

    const finish = (
      code: number | null,
      signal: NodeJS.Signals | null,
      notFound: boolean,
    ) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({
        code,
        signal,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        notFound,
        timedOut,
        aborted,
        stdoutTruncated,
        stderrTruncated,
      });
    };

    const stop = (reason: "timeout" | "abort" | "overflow") => {
      if (settled) return;
      if (reason === "timeout") timedOut = true;
      if (reason === "abort") aborted = true;
      if (stopping) return;
      stopping = true;
      signalChildProcess(child, "SIGTERM");
      killTimer = setTimeout(() => {
        killTimer = undefined;
        if (!settled) signalChildProcess(child, "SIGKILL");
      }, KILL_GRACE_MS);
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
        MAX_GITHUB_STDERR_BYTES,
      );
      stderrSize = result.size;
      if (result.truncated) stderrTruncated = true;
    });

    child.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        finish(null, null, true);
        return;
      }
      if (!settled) {
        settled = true;
        cleanup();
        reject(error);
      }
    });

    child.once("close", (code, signal) => {
      finish(code, signal, false);
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
  if (!isValidGhRequest(endpoint, options.accept)) {
    throw new GhRequestError("request");
  }
  let result: CommandResult;
  try {
    result = await execute(endpoint, options);
  } catch (error) {
    checkCancelled(options.signal);
    if (isEnoentError(error)) {
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
    throw classifyExitFailure(result);
  }
  try {
    return JSON.parse(result.stdout) as unknown;
  } catch {
    throw new GhRequestError("invalid-response");
  }
}
