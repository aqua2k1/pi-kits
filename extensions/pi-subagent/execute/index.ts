import { existsSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { truncateUtf8 } from "../util.ts";

export const MAX_COMMAND_BYTES = 64 * 1024;
export const MAX_RESULT_BYTES = 64 * 1024;
export const WORKER_MARKER = "PI_KITS_SUBAGENT_WORKER";

/** Stateless value handle returned by `start`. Holds native identity and optional sessionPath. */
export interface TerminalHandle {
  readonly id: string;
  readonly sessionPath?: string;
}

/** Stateless value handle returned by `open_view`. */
export interface ViewHandle {
  readonly id: string;
  readonly terminalId?: string;
  readonly space?: string;
  readonly tab?: string;
}

export class ExecutorError extends Error {
  constructor(
    public readonly code: string,
    detail?: string,
    options?: ErrorOptions,
  ) {
    super(detail ? `${code}: ${detail}` : code, options);
    this.name = "ExecutorError";
  }
}

export interface StartOptions {
  agentId: string;
  agentType?: string;
  cwd: string;
  sessionPath?: string;
  argv: string[];
  env: Record<string, string>;
}

export interface OpenViewOptions {
  terminal: TerminalHandle;
}

export interface ExecutorFactoryOptions {
  warn?: (message: string) => void;
  env?: NodeJS.ProcessEnv;
}

export type ExecutorId = "herdr-core" | "subprocess";

export type AgentExecutionState =
  | "idle"
  | "working"
  | "done"
  | "blocked"
  | "error";

export interface InspectResult {
  alive: boolean;
  state?: AgentExecutionState;
  turn?: number;
  message?: string;
  blockedKind?: "permission" | "question" | "auth";
}

export interface SendCommandOptions {
  if?: "idle" | "working";
}

export interface WaitOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface ReadStats {
  turnCount: number;
  toolUses: number;
  totalTokens: number;
  compactionCount: number;
  contextPercent?: number;
}

export interface ReadResult {
  text: string;
  error?: string;
  aborted?: boolean;
  truncated?: boolean;
  model?: string;
  sessionPath?: string;
  stats?: ReadStats;
}

/** Stateless executor contract: every method is a pure operator over value handles. */
export interface Executor {
  readonly id: ExecutorId;
  readonly supportsView: boolean;
  check_env(): boolean;
  start(options: StartOptions): Promise<TerminalHandle>;
  inspect(terminal: TerminalHandle): Promise<InspectResult>;
  send(
    terminal: TerminalHandle,
    text: string,
    options?: SendCommandOptions,
  ): Promise<void>;
  wait(terminal: TerminalHandle, options?: WaitOptions): Promise<InspectResult>;
  interrupt(terminal: TerminalHandle): Promise<void>;
  read(terminal: TerminalHandle): Promise<ReadResult>;
  destroy(terminal: TerminalHandle): Promise<void>;
  open_view?(options: OpenViewOptions): Promise<ViewHandle>;
  inspect_view?(view: ViewHandle): Promise<{ alive: boolean }>;
  focus_view?(view: ViewHandle): Promise<void>;
  close_view?(view: ViewHandle): Promise<void>;
}

export function buildChildEnv(
  baseEnv: NodeJS.ProcessEnv,
  overrides: Record<string, string>,
  omitKeys: string[] = [],
): Record<string, string> {
  const excluded = new Set(omitKeys);
  return Object.fromEntries(
    Object.entries({ ...baseEnv, ...overrides }).filter(
      (entry): entry is [string, string] =>
        !excluded.has(entry[0]) && entry[1] !== undefined,
    ),
  );
}

/**
 * Pure function: extracts the latest assistant turn response, error,
 * model, and usage statistics directly from a persisted Pi session JSONL file.
 */
export function readSessionSnapshot(sessionPath?: string): ReadResult {
  if (!sessionPath || !existsSync(sessionPath)) {
    return { text: "", ...(sessionPath ? { sessionPath } : {}) };
  }
  try {
    const branch = SessionManager.open(sessionPath).getBranch();
    let lastUserIdx = -1;
    let model: string | undefined;
    for (let i = 0; i < branch.length; i++) {
      const entry = branch[i];
      if (entry.type === "model_change") {
        model = `${entry.provider}/${entry.modelId}`;
      } else if (entry.type === "message") {
        if (entry.message.role === "user") lastUserIdx = i;
        else if (
          entry.message.role === "assistant" &&
          entry.message.provider &&
          entry.message.model
        ) {
          model = `${entry.message.provider}/${entry.message.model}`;
        }
      }
    }

    let turnCount = 0;
    let toolUses = 0;
    let totalTokens = 0;
    let compactionCount = 0;
    let text = "";
    let truncated = false;
    let error: string | undefined;
    let aborted = false;

    for (const entry of branch.slice(lastUserIdx + 1)) {
      if (entry.type === "compaction") {
        compactionCount += 1;
        continue;
      }
      if (entry.type !== "message" || entry.message.role !== "assistant") {
        continue;
      }
      const msg = entry.message;
      turnCount += 1;
      const u = msg.usage;
      totalTokens += (u?.input ?? 0) + (u?.output ?? 0) + (u?.cacheWrite ?? 0);
      if (Array.isArray(msg.content)) {
        toolUses += msg.content.filter((b) => b.type === "toolCall").length;
      }
      const rawText = Array.isArray(msg.content)
        ? msg.content
            .filter((b) => b.type === "text")
            .map((b) => b.text)
            .join("\n")
        : typeof msg.content === "string"
          ? msg.content
          : "";
      const bounded = truncateUtf8(rawText, MAX_RESULT_BYTES);
      text = bounded.text;
      truncated = bounded.truncated;
      error =
        msg.stopReason === "error"
          ? truncateUtf8(msg.errorMessage || "Pi assistant failed", 4096).text
          : undefined;
      aborted = msg.stopReason === "aborted";
    }

    return {
      text,
      ...(error ? { error } : {}),
      ...(aborted ? { aborted: true } : {}),
      ...(truncated ? { truncated: true } : {}),
      ...(model ? { model } : {}),
      sessionPath,
      stats: { turnCount, toolUses, totalTokens, compactionCount },
    };
  } catch {
    return { text: "", sessionPath };
  }
}

function withSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    signal.throwIfAborted();
    const onAbort = () => reject(signal.reason ?? new Error("Wait canceled."));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", onAbort);
    });
  });
}

export interface ExecutorSpec<
  TTerminal extends TerminalHandle = TerminalHandle,
  TView extends ViewHandle = ViewHandle,
> {
  readonly id: ExecutorId;
  readonly supportsView?: boolean;
  readonly pollIntervalMs?: number;
  check_env(): boolean;
  start(options: StartOptions): Promise<TTerminal>;
  inspect(terminal: TTerminal): Promise<InspectResult>;
  send(
    terminal: TTerminal,
    text: string,
    options?: SendCommandOptions,
  ): Promise<void>;
  interrupt(terminal: TTerminal): Promise<void>;
  destroy(terminal: TTerminal): Promise<void>;
  wait?(terminal: TTerminal, options?: WaitOptions): Promise<InspectResult>;
  read?(
    terminal: TTerminal,
    fallback: () => Promise<ReadResult>,
  ): Promise<ReadResult>;
  open_view?(options: { terminal: TTerminal }): Promise<TView>;
  inspect_view?(view: TView): Promise<{ alive: boolean }>;
  focus_view?(view: TView): Promise<void>;
  close_view?(view: TView): Promise<void>;
}

/**
 * Pure stateless executor combinator:
 * - Zero internal Maps, Sets, or mutable handle tables
 * - Attaches `sessionPath` to the returned `TerminalHandle`
 * - Provides default `read` via `readSessionSnapshot(terminal.sessionPath)`
 * - Provides default `wait` via `inspect` polling
 */
export function defineExecutor<
  TTerminal extends TerminalHandle = TerminalHandle,
  TView extends ViewHandle = ViewHandle,
>(spec: ExecutorSpec<TTerminal, TView>): Executor {
  const pollIntervalMs = spec.pollIntervalMs ?? 50;
  const supportsView =
    spec.supportsView ?? Boolean(spec.open_view && spec.close_view);

  const defaultWait = async (
    terminal: TTerminal,
    waitOpts?: WaitOptions,
  ): Promise<InspectResult> => {
    const deadline =
      waitOpts?.timeoutMs !== undefined
        ? Date.now() + waitOpts.timeoutMs
        : Number.POSITIVE_INFINITY;
    for (;;) {
      waitOpts?.signal?.throwIfAborted();
      const status = await spec.inspect(terminal);
      if (
        !status.alive ||
        (status.state && status.state !== "working") ||
        Date.now() >= deadline
      ) {
        return status;
      }
      await delay(pollIntervalMs, undefined, { signal: waitOpts?.signal });
    }
  };

  const openView = supportsView ? spec.open_view : undefined;
  return {
    id: spec.id,
    supportsView,
    check_env: () => spec.check_env(),
    start: async (startOpts) => {
      const idx = startOpts.argv.indexOf("--session");
      const sessionPath =
        startOpts.sessionPath ??
        (idx >= 0 ? startOpts.argv[idx + 1] : undefined);
      const handle = await spec.start({
        ...startOpts,
        sessionPath,
        argv: [...startOpts.argv],
        env: { ...startOpts.env },
      });
      return sessionPath && !handle.sessionPath
        ? Object.assign(handle, { sessionPath })
        : handle;
    },
    inspect: (terminal) => spec.inspect(terminal as TTerminal),
    send: async (terminal, text, sendOpts) => {
      if (!text.trim()) throw new ExecutorError("invalid_prompt");
      if (Buffer.byteLength(text, "utf8") > MAX_COMMAND_BYTES) {
        throw new ExecutorError("command_too_large");
      }
      await spec.send(terminal as TTerminal, text, sendOpts);
    },
    wait: (terminal, waitOpts) => {
      const t = terminal as TTerminal;
      const op = spec.wait ? spec.wait(t, waitOpts) : defaultWait(t, waitOpts);
      return withSignal(op, waitOpts?.signal);
    },
    interrupt: (terminal) => spec.interrupt(terminal as TTerminal),
    read: (terminal) => {
      const t = terminal as TTerminal;
      const fallback = async () => readSessionSnapshot(t.sessionPath);
      return spec.read ? spec.read(t, fallback) : fallback();
    },
    destroy: (terminal) => spec.destroy(terminal as TTerminal),
    ...(openView
      ? {
          open_view: (opts: OpenViewOptions) =>
            openView({ terminal: opts.terminal as TTerminal }),
          inspect_view: (view: ViewHandle) =>
            spec.inspect_view
              ? spec.inspect_view(view as TView)
              : Promise.resolve({ alive: true }),
          focus_view: (view: ViewHandle) =>
            spec.focus_view
              ? spec.focus_view(view as TView)
              : Promise.resolve(),
          close_view: (view: ViewHandle) =>
            spec.close_view
              ? spec.close_view(view as TView)
              : Promise.resolve(),
        }
      : {}),
  };
}
