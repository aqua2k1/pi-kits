import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TerminalHandle, TerminalStartError } from "../../mux/index.ts";
import { createSerializer, truncateUtf8 } from "../../util.ts";
import {
  type AgentRuntime,
  MAX_RESULT_BYTES,
  type RuntimeCapabilities,
  type RuntimeCommand,
  type RuntimeEvent,
  type RuntimeHost,
  type RuntimeOptions,
  type RuntimeSession,
  RuntimeTaskRejectedError,
  type SessionUpdate,
} from "../index.ts";
import {
  type CodexConfig,
  codexConfig,
  codexNativeArgs,
  parseCodexCallConfig,
  parseCodexConfig,
  parseCodexTask,
} from "./config.ts";
import { spawnCodexGuardian } from "./guardian.ts";
import {
  CODEX_REQUEST_TIMEOUT_MS,
  type CodexConnectOptions,
  type CodexRpc,
  connectCodexTransport,
} from "./transport.ts";

const capabilities: RuntimeCapabilities = Object.freeze({
  nativeClone: false,
  steer: true,
  retainedSession: true,
  concurrentNativeInput: true,
});
const INTERACTION_HISTORY_LIMIT = 256;
const efforts: Record<string, string> = {
  off: "none",
  none: "none",
  minimal: "minimal",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
};
const TOOL_ITEM_TYPES = new Set([
  "commandExecution",
  "fileChange",
  "mcpToolCall",
  "dynamicToolCall",
  "collabAgentToolCall",
  "webSearch",
  "imageGeneration",
]);
const NON_ACTIVITY_ITEM_TYPES = new Set([
  "agentMessage",
  "userMessage",
  "reasoning",
  "enteredReviewMode",
  "exitedReviewMode",
]);

function effort(options: RuntimeOptions): string | undefined {
  const value = options.agent?.thinking ?? options.thinking;
  return value === undefined ? undefined : efforts[value];
}

const bounded = (text: string, limit = MAX_RESULT_BYTES) =>
  truncateUtf8(text, limit);
const textInput = (text: string) => [{ type: "text", text, text_elements: [] }];

type NativeItem = {
  id: string;
  type: string;
  text?: string;
  review?: string;
  phase?: string | null;
};
type NativeTurn = {
  id: string;
  status: string;
  itemsView?: string;
  items?: NativeItem[];
  error?: { message?: string } | null;
};
type NativeThread = {
  id: string;
  sessionId?: string;
  path?: string | null;
  status?: { type: string };
  model?: string;
  modelProvider?: string;
  reasoningEffort?: string | null;
};
type NativeUsage = {
  total: Record<string, number>;
  last: Record<string, number>;
  modelContextWindow?: number | null;
};
type ModelEntry = {
  id: string;
  model: string;
  isDefault: boolean;
  supportedReasoningEfforts: Array<{ reasoningEffort: string }>;
};
type StartupResponse = {
  userAgent?: string;
  thread?: NativeThread;
  model?: string;
  modelProvider?: string;
  reasoningEffort?: string | null;
  data?: ModelEntry[];
  nextCursor?: string | null;
};
type NativeEvent = {
  threadId?: string;
  turnId?: string;
  turn?: NativeTurn;
  item?: NativeItem;
  tokenUsage?: NativeUsage;
  status?: { type: string };
  requestMethod?: string;
};

type NativeInteraction = {
  id: string;
  sequence: number;
  finishing: boolean;
  final?: { text: string; truncated: boolean };
  fallback?: { text: string; truncated: boolean };
  review?: { text: string; truncated: boolean };
  reviewing?: boolean;
};

type ManagedTurn = {
  round: number;
  sequence: number;
  id?: string;
  submitted: Promise<void>;
  releaseSubmission(): void;
  cancel: boolean;
  interruptSent: boolean;
  dispatched: boolean;
  finishing: boolean;
  early: Array<[string, Record<string, unknown>]>;
  final: string;
  review: boolean;
  reviewResult?: string;
  fallback: string;
  truncated: boolean;
  items: Set<string>;
  tools: number;
  compactions: number;
  usage?: NativeUsage;
  baseline: Record<string, number>;
};

function validateCodexOptions(
  options: RuntimeOptions,
  _config = codexConfig(options),
): void {
  if (options.parentSession) {
    throw new Error(
      "Codex cannot clone a Pi parentSession; use an explicit prompt",
    );
  }
  const thinking = options.agent?.thinking ?? options.thinking;
  if (thinking !== undefined && !Object.hasOwn(efforts, thinking)) {
    throw new Error(`Unsupported Codex thinking effort: ${thinking}`);
  }
  if (
    options.startupTimeoutMs !== undefined &&
    (!Number.isFinite(options.startupTimeoutMs) ||
      options.startupTimeoutMs <= 0)
  ) {
    throw new Error("Invalid Codex startup timeout");
  }
}

function buildAppServerArgv(
  url: string,
  tokenFile: string,
  config: CodexConfig,
): string[] {
  return [
    "app-server",
    "--listen",
    url,
    "--ws-auth",
    "capability-token",
    "--ws-token-file",
    tokenFile,
    ...codexNativeArgs(config),
  ];
}

function buildThreadStartParams(
  options: RuntimeOptions,
  codexCfg: CodexConfig,
  systemPrompt: string,
): Record<string, unknown> {
  const configuredEffort = effort(options);
  const model = options.agent?.model ?? options.model;
  const config: Record<string, unknown> = {};
  if (configuredEffort !== undefined) {
    config.model_reasoning_effort = configuredEffort;
  }
  // Native review delegates disable web search even when the thread enables it.
  if (codexCfg.runtime_args.includes("search")) {
    config.web_search = "live";
  }
  return {
    cwd: options.cwd,
    model,
    sandbox: "workspace-write",
    approvalPolicy: "never",
    developerInstructions: systemPrompt || undefined,
    ...(Object.keys(config).length ? { config } : {}),
  };
}

function computeUsageDelta(
  usage: NativeUsage | undefined,
  baseline: Record<string, number>,
): { totalTokens: number; delta: Record<string, number> } {
  const delta: Record<string, number> = {};
  for (const [key, value] of Object.entries(usage?.total ?? {})) {
    if (Number.isSafeInteger(value) && value >= 0) {
      delta[key] = Math.max(0, value - (baseline[key] ?? 0));
    }
  }
  const totalTokens =
    Math.max(0, (delta.inputTokens ?? 0) - (delta.cachedInputTokens ?? 0)) +
    (delta.outputTokens ?? 0);
  return { totalTokens, delta };
}

function buildStatsEvent(
  managed: ManagedTurn,
): Extract<RuntimeEvent, { type: "stats" }> {
  const { totalTokens, delta } = computeUsageDelta(
    managed.usage,
    managed.baseline,
  );
  return {
    type: "stats",
    round: managed.round,
    turnId: managed.id,
    turnCount: managed.finishing ? 1 : 0,
    toolUses: managed.tools,
    compactionCount: managed.compactions,
    totalTokens,
    usage: managed.usage ? { ...managed.usage, delta } : undefined,
  };
}

function buildNativeSessionUpdate(
  interaction: NativeInteraction,
  turn: NativeTurn,
  hydrationError: string | undefined,
): SessionUpdate {
  const result =
    interaction.review ?? interaction.final ?? interaction.fallback;
  const error =
    turn.status === "failed"
      ? String(turn.error?.message ?? "Codex turn failed")
      : hydrationError;
  return {
    type: "session_update",
    interactionId: interaction.id,
    sequence: interaction.sequence,
    response: result?.text ?? "",
    outcome:
      turn.status === "interrupted"
        ? "aborted"
        : error !== undefined
          ? "error"
          : "completed",
    truncated: result?.truncated ?? false,
    ...(error === undefined ? {} : { error }),
  };
}

function buildTurnCompletion(
  managed: ManagedTurn,
  turn: NativeTurn,
  hydrationError: string | undefined,
): Extract<RuntimeEvent, { type: "completed" }> {
  return {
    type: "completed",
    round: managed.round,
    turnId: managed.id,
    resultSequence: managed.sequence,
    result: managed.reviewResult ?? (managed.final || managed.fallback),
    truncated: managed.truncated,
    canceled: turn.status === "interrupted",
    error:
      turn.status === "failed"
        ? String(turn.error?.message ?? "Codex turn failed")
        : hydrationError,
  };
}

/** Injectable OS/transport boundary: tests never invoke a real model or CLI. */
export interface CodexDependencies {
  probe(executable: string, cwd: string, timeoutMs: number): Promise<string>;
  address(): Promise<string>;
  removeDirectory(path: string): Promise<void>;
  spawn(executable: string, argv: string[], cwd: string): ChildProcess;
  connect(options: CodexConnectOptions): Promise<CodexRpc>;
}

const defaults: CodexDependencies = {
  async removeDirectory(path) {
    await rm(path, { recursive: true, force: true });
  },
  probe(executable, cwd, timeoutMs) {
    return new Promise((resolve, reject) => {
      const child = spawn(executable, ["--version"], {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.kill("SIGKILL");
        if (error) reject(error);
        else resolve(output);
      };
      const timer = setTimeout(
        () => finish(new Error("Codex version probe timed out")),
        timeoutMs,
      );
      child.stdout?.on("data", (chunk) => {
        output = bounded(output + chunk.toString(), 4096).text;
      });
      child.stderr?.resume();
      child.on("error", () => finish(new Error("Cannot execute Codex CLI")));
      // exit can precede delivery of the final stdout chunk; close waits for pipe drainage.
      child.on("close", (code) =>
        finish(
          code === 0 ? undefined : new Error("Codex version probe failed"),
        ),
      );
    });
  },
  address() {
    return new Promise((resolve, reject) => {
      const server = createServer();
      server.on("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (!address || typeof address === "string") {
          server.close();
          reject(new Error("No loopback port"));
          return;
        }
        server.close((error) =>
          error ? reject(error) : resolve(`ws://127.0.0.1:${address.port}`),
        );
      });
    });
  },
  spawn: spawnCodexGuardian,
  connect: connectCodexTransport,
};

function createCodexSession(
  options: RuntimeOptions,
  config: CodexConfig,
  host: RuntimeHost,
  deps: CodexDependencies,
): RuntimeSession {
  const systemPrompt = options.agent?.systemPrompt ?? "";
  const serializeCleanup = createSerializer();
  const interactionHistory = new Set<string>();

  let rpc: CodexRpc | undefined;
  let child: ChildProcess | undefined;
  let dir: string | undefined;
  let url = "";
  let token = "";
  let threadId: string | undefined;
  let runtimeSessionId: string | undefined;
  let ready = false;
  let closed = false;
  let lost = false;
  let startPromise: Promise<void> | undefined;
  let closePromise: Promise<void> | undefined;
  let nativeTerminal: TerminalHandle | undefined;
  let attaching = false;
  let attachmentPromise: Promise<TerminalHandle> | undefined;
  let managed: ManagedTurn | undefined;
  let nativeTurnId: string | undefined;
  let nativeInteraction: NativeInteraction | undefined;
  // Start order spans managed and native turns, independent of round numbers.
  let replySequence = 0;
  let lastRound = 0;
  let latestUsage: NativeUsage | undefined;

  const isConnected = (): boolean => ready && !closed && !lost;

  const emit = (event: RuntimeEvent): void => {
    host.emit({ ...event, threadId, runtimeSessionId });
  };

  const disconnect = (error: Error): void => {
    if (closed || lost) return;
    lost = true;
    ready = false;
    emit({
      type: "disconnected",
      error: error.message,
      round: managed?.round,
    });
    // The manager owns disconnect cleanup for every session state. Retain
    // handles until close() succeeds so failures remain retryable.
  };

  const requireConnected = (): CodexRpc => {
    if (!isConnected() || !rpc) {
      throw new Error("Codex session is disconnected; start a new session");
    }
    return rpc;
  };

  const rememberInteraction = (id: string): void => {
    interactionHistory.add(id);
    if (interactionHistory.size > INTERACTION_HISTORY_LIMIT) {
      const oldest = interactionHistory.values().next().value;
      if (oldest !== undefined) interactionHistory.delete(oldest);
    }
  };

  const startupRequest = async (
    method: string,
    params: unknown,
    ms: number,
  ): Promise<StartupResponse> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const currentRpc = rpc;
    if (!currentRpc) throw new Error("Codex startup transport missing");
    try {
      return await Promise.race([
        currentRpc.request<StartupResponse>(method, params),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`Codex startup timeout: ${method}`)),
            ms,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };

  const nativeAlive = async (): Promise<boolean> => {
    if (attaching) return true;
    if (!nativeTerminal) return false;
    const terminal = nativeTerminal;
    const { alive } = await host.mux.inspect(terminal);
    if (!alive && nativeTerminal === terminal) {
      await host.mux.destroy(terminal);
      if (nativeTerminal === terminal) nativeTerminal = undefined;
    }
    return alive;
  };

  const shouldRejectServerRequest = (): boolean | Promise<boolean> => {
    const headless = () =>
      isConnected() && Boolean(managed?.dispatched && !managed.finishing);
    if (!headless()) return false;
    if (!nativeTerminal && !attaching) return true;
    // App-server broadcasts requests to native clients too. Never race their
    // answer, but resume headless rejection if the native terminal has exited.
    return nativeAlive().then((alive) => headless() && !alive);
  };

  const hydrateTurnItems = async (
    turnId: string | undefined,
    onItem: (item: NativeItem) => void,
    isValid: () => boolean = () => true,
  ): Promise<string | undefined> => {
    try {
      let cursor: string | undefined;
      const cursors = new Set<string>();
      for (let page = 0; page < 64; page++) {
        const result = await requireConnected().request<{
          data: Array<{ item: NativeItem }>;
          nextCursor?: string | null;
        }>("thread/items/list", {
          threadId,
          turnId,
          limit: 100,
          sortDirection: "asc",
          cursor,
        });
        if (!isConnected() || !isValid()) return undefined;
        if (!Array.isArray(result?.data)) {
          throw new Error("Invalid Codex item page");
        }
        for (const entry of result.data) onItem(entry.item);
        if (!result.nextCursor) break;
        if (cursors.has(result.nextCursor) || page === 63) {
          throw new Error("Codex item pagination limit exceeded");
        }
        cursors.add(result.nextCursor);
        cursor = result.nextCursor;
      }
      return undefined;
    } catch (error) {
      return error instanceof Error
        ? error.message
        : "Codex item hydration failed";
    }
  };

  const cacheNativeItem = (
    interaction: NativeInteraction,
    item: NativeItem | undefined,
  ): void => {
    if (!item) return;
    if (item.type === "enteredReviewMode") interaction.reviewing = true;
    if (item.type === "exitedReviewMode" && typeof item.review === "string") {
      interaction.review = bounded(item.review);
    }
    if (item.type === "agentMessage" && typeof item.text === "string") {
      if (item.phase === "final_answer") interaction.final = bounded(item.text);
      else interaction.fallback = bounded(item.text);
    }
  };

  const completeNative = async (
    interaction: NativeInteraction,
    turn: NativeTurn,
  ): Promise<void> => {
    for (const item of turn.items ?? []) cacheNativeItem(interaction, item);
    let hydrationError: string | undefined;
    if (
      turn.itemsView !== "full" &&
      interaction.review === undefined &&
      (interaction.reviewing || interaction.final === undefined)
    ) {
      hydrationError = await hydrateTurnItems(
        interaction.id,
        (item) => cacheNativeItem(interaction, item),
        () => nativeInteraction === interaction,
      );
    }
    if (!isConnected() || nativeInteraction !== interaction) return;
    emit(buildNativeSessionUpdate(interaction, turn, hydrationError));
    interaction.finishing = false;
    // Emission can synchronously start a new round/turn or close the session.
    // Never let an old hydration overwrite that newer lifecycle.
    if (
      isConnected() &&
      nativeInteraction === interaction &&
      !managed &&
      !nativeTurnId
    ) {
      emit({ type: "session_state", state: "idle" });
    }
  };

  const nativeNotification = (method: string, params: NativeEvent): void => {
    const id = params.turnId ?? params.turn?.id;
    if (
      !id ||
      interactionHistory.has(id) ||
      ![
        "turn/started",
        "turn/completed",
        "item/started",
        "item/completed",
      ].includes(method)
    ) {
      return;
    }
    // Retry/error notifications are not turn completion. Only terminal turn
    // statuses can publish a result, even if a final item arrived earlier.
    if (
      method === "turn/completed" &&
      !["completed", "interrupted", "failed"].includes(
        params.turn?.status ?? "",
      )
    ) {
      return;
    }
    let interaction = nativeInteraction;
    if (interaction?.id !== id) {
      // A late item/completion from another turn must not replace a newer
      // active turn. A new turn/started is the authoritative ordering signal.
      if (interaction && nativeTurnId && method !== "turn/started") {
        rememberInteraction(id);
        return;
      }
      if (interaction) rememberInteraction(interaction.id);
      interaction = { id, sequence: ++replySequence, finishing: false };
      nativeInteraction = interaction;
    }
    if (interaction.finishing) return;
    if (method === "turn/started") nativeTurnId = id;
    if (method === "item/started" || method === "item/completed") {
      cacheNativeItem(interaction, params.item);
    }
    if (method === "turn/completed" && params.turn) {
      interaction.finishing = true;
      rememberInteraction(id);
      if (nativeTurnId === id) nativeTurnId = undefined;
      void completeNative(interaction, params.turn);
    }
  };

  const cacheItem = (turn: ManagedTurn, item: NativeItem | undefined): void => {
    if (!item || typeof item.id !== "string") return;
    if (!turn.items.has(item.id)) {
      turn.items.add(item.id);
      if (TOOL_ITEM_TYPES.has(item.type)) turn.tools++;
      if (item.type === "contextCompaction") turn.compactions++;
    }
    if (item.type === "exitedReviewMode" && typeof item.review === "string") {
      const result = bounded(item.review);
      turn.reviewResult = result.text;
      turn.truncated ||= result.truncated;
    }
    if (item.type === "agentMessage" && typeof item.text === "string") {
      const result = bounded(item.text);
      if (item.phase === "final_answer") turn.final = result.text;
      else turn.fallback = result.text;
      turn.truncated ||= result.truncated;
    }
  };

  const completeManaged = async (
    current: ManagedTurn,
    turn: NativeTurn,
  ): Promise<void> => {
    for (const item of turn.items ?? []) cacheItem(current, item);
    let hydrationError: string | undefined;
    if (
      turn.itemsView !== "full" &&
      (current.review ? current.reviewResult === undefined : !current.final)
    ) {
      hydrationError = await hydrateTurnItems(current.id, (item) =>
        cacheItem(current, item),
      );
    }
    if (managed !== current || !isConnected()) return;
    emit(buildStatsEvent(current));
    managed = undefined;
    const interactive = Boolean(nativeTurnId || nativeInteraction?.finishing);
    emit({
      type: "session_state",
      state: interactive ? "interactive" : "idle",
      activity: interactive ? "Native Codex turn" : undefined,
      round: current.round,
      turnId: current.id,
    });
    emit(buildTurnCompletion(current, turn, hydrationError));
  };

  const notification = (method: string, raw: Record<string, unknown>): void => {
    const params = raw as NativeEvent;
    if (!params || params.threadId !== threadId || !isConnected()) return;
    if (method === "thread/tokenUsage/updated" && params.tokenUsage) {
      latestUsage = params.tokenUsage;
    }
    const current = managed;
    const turnId = params.turnId ?? params.turn?.id;
    if (method === "thread/status/changed" && params.status?.type === "idle") {
      nativeTurnId = undefined;
    }
    if (!current) {
      nativeNotification(method, params);
      // Backend idle is not publication completion: hydration still owns the
      // native result. completeNative publishes idle after session_update.
      if (
        method === "thread/status/changed" &&
        !(params.status?.type === "idle" && nativeInteraction?.finishing)
      ) {
        emit({
          type: "session_state",
          state: params.status?.type === "active" ? "interactive" : "idle",
          activity:
            params.status?.type === "active" ? "Native Codex turn" : undefined,
        });
      }
      return;
    }
    if (method === "runtime/blocked") {
      emit({
        type: "blocked",
        round: current.round,
        turnId,
        requestMethod: params.requestMethod,
        error: "Interactive Codex request rejected by headless runtime",
      });
      emit({
        type: "activity",
        round: current.round,
        toolName: params.requestMethod,
        event: "blocked",
      });
      return;
    }
    if (!current.id) {
      if (
        !turnId ||
        ![
          "turn/started",
          "turn/completed",
          "item/started",
          "item/completed",
          "thread/tokenUsage/updated",
        ].includes(method)
      ) {
        return;
      }
      if (current.early.length >= 64) {
        disconnect(new Error("Codex startup event buffer exceeded"));
        return;
      }
      current.early.push([method, raw]);
      return;
    }
    if (turnId !== current.id) {
      nativeNotification(method, params);
      return; // Native turns never belong to a managed round.
    }
    if (current.finishing) return;
    if (method === "item/started" || method === "item/completed") {
      cacheItem(current, params.item);
      const tool = params.item?.type;
      if (tool && !NON_ACTIVITY_ITEM_TYPES.has(tool)) {
        emit({
          type: "activity",
          round: current.round,
          turnId,
          toolName: tool,
          event:
            method === "item/started"
              ? "tool_execution_start"
              : "tool_execution_end",
        });
      }
    }
    if (method === "thread/tokenUsage/updated") {
      current.usage = params.tokenUsage;
      emit(buildStatsEvent(current));
    }
    if (method === "turn/completed" && params.turn) {
      current.finishing = true;
      void completeManaged(current, params.turn).catch((error) =>
        disconnect(error),
      );
    }
  };

  const cleanupResources = async (): Promise<void> => {
    const currentRpc = rpc;
    rpc = undefined;
    currentRpc?.close();
    const currentChild = child;
    if (
      currentChild &&
      currentChild.exitCode === null &&
      currentChild.signalCode === null
    ) {
      // Guardian kill() requests group cleanup over IPC; even SIGKILL is not
      // proof of exit. Never OS-kill the guardian and orphan its backend.
      await new Promise<void>((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout>;
        const exited = () => {
          clearTimeout(timer);
          resolve();
        };
        const failed = (cause: unknown) => {
          clearTimeout(timer);
          currentChild.removeListener("exit", exited);
          reject(cause);
        };
        currentChild.once("exit", exited);
        timer = setTimeout(() => {
          timer = setTimeout(
            () =>
              failed(new Error("Codex guardian exit unconfirmed; retry close")),
            500,
          );
          try {
            currentChild.kill("SIGKILL");
          } catch (cause) {
            failed(cause);
          }
        }, 500);
        try {
          currentChild.kill("SIGTERM");
        } catch (cause) {
          failed(cause);
        }
      });
    }
    // Retain child, credentials and directory on an unconfirmed stop so the
    // manager cannot release its concurrency claim and retries keep ownership.
    if (child === currentChild) child = undefined;
    const terminal = nativeTerminal;
    let terminalError: unknown;
    if (terminal) {
      try {
        await host.mux.destroy(terminal);
        if (nativeTerminal === terminal) nativeTerminal = undefined;
      } catch (error) {
        terminalError = error;
      }
    }
    const currentDir = dir;
    if (currentDir) {
      await deps.removeDirectory(currentDir);
      dir = undefined;
    }
    token = "";
    if (terminalError) throw terminalError;
  };

  const cleanup = (): Promise<void> => serializeCleanup(cleanupResources);

  const startBackend = async (): Promise<void> => {
    const deadline = Date.now() + (options.startupTimeoutMs ?? 15_000);
    const remaining = () => {
      if (closed || lost) throw new Error("Codex startup aborted");
      const ms = deadline - Date.now();
      if (ms <= 0) throw new Error("Codex startup timed out");
      return ms;
    };
    let version: string | undefined;
    try {
      // Version is diagnostic only. Compatibility is established by starting
      // the authenticated server and validating the required RPC responses.
      version = await deps.probe(
        options.executable ?? "codex",
        options.cwd,
        remaining(),
      );
      remaining();
      dir = await mkdtemp(join(tmpdir(), "pi-kits-codex-"));
      await chmod(dir, 0o700);
      token = randomBytes(32).toString("hex");
      const tokenFile = join(dir, "token");
      await writeFile(tokenFile, token, { mode: 0o600 });
      await chmod(tokenFile, 0o600);
      url = await deps.address();
      remaining();
      child = deps.spawn(
        options.executable ?? "codex",
        buildAppServerArgv(url, tokenFile, config),
        options.cwd,
      );
      // Drain diagnostics without retaining or forwarding secrets/unbounded output.
      child.stdout?.resume();
      child.stderr?.resume();
      child.on("error", () =>
        disconnect(new Error("Codex app-server process error")),
      );
      child.on("exit", (code, signal) =>
        disconnect(new Error(`Codex app-server exited (${code ?? signal})`)),
      );
      let lastConnectError: unknown;
      while (!rpc) {
        try {
          rpc = await deps.connect({
            url,
            token,
            notification,
            disconnected: disconnect,
            connectTimeoutMs: Math.min(1000, remaining()),
            requestTimeoutMs: CODEX_REQUEST_TIMEOUT_MS,
            shouldRejectServerRequest,
          });
        } catch (error) {
          lastConnectError = error;
          if (closed || lost) throw new Error("Codex startup aborted");
          if (deadline - Date.now() <= 0) {
            const detail =
              lastConnectError instanceof Error
                ? `: ${lastConnectError.message}`
                : "";
            throw new Error(`Codex startup timed out${detail}`, {
              cause: lastConnectError,
            });
          }
          await new Promise((resolve) => setTimeout(resolve, 40));
        }
      }
      const initialized = await startupRequest(
        "initialize",
        {
          clientInfo: {
            name: "pi-kits-subagent",
            title: "Pi subagent",
            version: "0.1.0",
          },
          capabilities: { experimentalApi: false, requestAttestation: false },
        },
        remaining(),
      );
      if (typeof initialized?.userAgent !== "string") {
        throw new Error("Incompatible Codex initialize response");
      }
      rpc.notify("initialized");
      const configuredEffort = effort(options);
      const model = options.agent?.model ?? options.model;
      if (configuredEffort !== undefined) {
        let cursor: string | undefined;
        let selected: ModelEntry | undefined;
        for (let page = 0; page < 16; page++) {
          const catalog = await startupRequest(
            "model/list",
            { includeHidden: true, limit: 100, cursor },
            remaining(),
          );
          if (!Array.isArray(catalog?.data)) {
            throw new Error("Incompatible Codex model catalog");
          }
          selected = catalog.data.find((entry) =>
            model
              ? entry.model === model || entry.id === model
              : entry.isDefault,
          );
          if (selected || !catalog.nextCursor) break;
          cursor = catalog.nextCursor;
        }
        if (
          !selected?.supportedReasoningEfforts?.some(
            (entry) => entry.reasoningEffort === configuredEffort,
          )
        ) {
          throw new Error(
            `Codex model does not support requested effort: ${configuredEffort}`,
          );
        }
      }
      const started = await startupRequest(
        "thread/start",
        buildThreadStartParams(options, config, systemPrompt),
        remaining(),
      );
      if (typeof started?.thread?.id !== "string") {
        throw new Error("Incompatible Codex thread/start response");
      }
      remaining();
      threadId = started.thread.id;
      runtimeSessionId = started.thread.sessionId ?? started.thread.id;
      if (options.sessionName) {
        await startupRequest(
          "thread/name/set",
          { threadId, name: options.sessionName },
          remaining(),
        );
      }
      ready = true;
      emit({
        type: "model_select",
        provider: started.modelProvider,
        model: started.model,
        thinkingLevel: started.reasoningEffort,
      });
      emit({
        type: "session_state",
        state: "idle",
        sessionPath: started.thread.path ?? undefined,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Unknown error";
      const failure = new Error(
        `Codex startup failed${version?.trim() ? ` (${version.trim()})` : ""}: ${detail}`,
        { cause: error },
      );
      disconnect(failure);
      await cleanup();
      throw failure;
    }
  };

  const exclusiveCheck = async (): Promise<void> => {
    const { thread } = await requireConnected().request<StartupResponse>(
      "thread/read",
      { threadId, includeTurns: false },
    );
    if (!thread || thread.status?.type !== "idle") {
      throw new RuntimeTaskRejectedError(
        "Codex thread is not idle; wait for the native turn to finish",
      );
    }
    if (typeof thread.model === "string") {
      emit({
        type: "model_select",
        model: thread.model,
        provider: thread.modelProvider,
        thinkingLevel: thread.reasoningEffort,
      });
    }
  };

  const managedForRound = (
    round: number | undefined,
  ): ManagedTurn | undefined =>
    managed && (round === undefined || round === managed.round)
      ? managed
      : undefined;

  const interrupt = async (current: ManagedTurn): Promise<void> => {
    if (
      !current.cancel ||
      !current.id ||
      current.interruptSent ||
      current.finishing
    ) {
      return;
    }
    current.interruptSent = true;
    await requireConnected().request("turn/interrupt", {
      threadId,
      turnId: current.id,
    });
    // Only turn/completed(status=interrupted) confirms cancellation.
  };

  const openAttachment = async (): Promise<TerminalHandle> => {
    try {
      if (nativeTerminal) {
        if ((await host.mux.inspect(nativeTerminal)).alive) {
          requireConnected();
          return nativeTerminal;
        }
        const previous = nativeTerminal;
        await host.mux.destroy(previous);
        if (nativeTerminal === previous) nativeTerminal = undefined;
      }
      requireConnected();
      if (!threadId) throw new Error("Codex attachment thread missing");
      const terminal = await host.mux.start({
        agentId: options.id,
        agentType: options.agent?.name,
        cwd: options.cwd,
        argv: [
          options.executable ?? "codex",
          "--remote",
          url,
          "--remote-auth-token-env",
          "PI_KITS_CODEX_TOKEN",
          "resume",
          threadId,
        ],
        env: { PI_KITS_CODEX_TOKEN: token, PI_KITS_SUBAGENT_WORKER: "1" },
      });
      // Take ownership before checking lifecycle state: even a late terminal
      // must remain available to close(), including when destroy fails.
      nativeTerminal = terminal;
      if (!isConnected()) {
        throw new Error(
          "Codex session closed or disconnected during attachment",
        );
      }
      return terminal;
    } catch (error) {
      if (error instanceof TerminalStartError) {
        nativeTerminal = error.terminal;
        // An in-flight close waits for us and owns cleanup/error propagation.
        if (!closed) {
          await host.mux.destroy(error.terminal);
          if (nativeTerminal === error.terminal) nativeTerminal = undefined;
        }
      }
      throw error;
    }
  };

  return {
    capabilities,
    get connected() {
      return isConnected();
    },
    get terminal() {
      return nativeTerminal;
    },
    start() {
      if (closed) return Promise.reject(new Error("Codex session closed"));
      startPromise ??= startBackend();
      return startPromise;
    },
    async send(rawCommand: RuntimeCommand) {
      let command: RuntimeCommand;
      try {
        command = parseCodexTask(rawCommand, options);
      } catch (cause) {
        throw new RuntimeTaskRejectedError(
          cause instanceof Error ? cause.message : "Invalid Codex task",
          { cause },
        );
      }
      const controlRpc = requireConnected();
      if (command.type === "cancel") {
        const current = managedForRound(command.round);
        if (!current) return;
        current.cancel = true;
        await interrupt(current);
        return;
      }
      if (command.type === "steer") {
        const current = managedForRound(command.round);
        if (!current?.id || current.finishing) {
          throw new Error("No matching managed Codex turn to steer");
        }
        await controlRpc.request("turn/steer", {
          threadId,
          expectedTurnId: current.id,
          input: textInput(command.message),
        });
        return;
      }
      if (managed) {
        throw new RuntimeTaskRejectedError(
          "Codex managed task already in progress",
        );
      }
      const round = command.round ?? lastRound + 1;
      if (!Number.isSafeInteger(round) || round <= lastRound) {
        throw new RuntimeTaskRejectedError("Invalid Codex managed round");
      }
      let releaseSubmission!: () => void;
      const submitted = new Promise<void>((resolve) => {
        releaseSubmission = resolve;
      });
      const current: ManagedTurn = {
        round,
        sequence: ++replySequence,
        submitted,
        releaseSubmission,
        cancel: false,
        interruptSent: false,
        dispatched: false,
        finishing: false,
        early: [],
        final: "",
        review: config.runtime_args.includes("review"),
        fallback: "",
        truncated: false,
        items: new Set(),
        tools: 0,
        compactions: 0,
        baseline: { ...latestUsage?.total },
      };
      managed = current; // Attachments wait until turn/start has settled.
      try {
        await exclusiveCheck();
        current.baseline = { ...latestUsage?.total };
        lastRound = round;
        if (current.cancel) {
          managed = undefined;
          emit(buildStatsEvent(current));
          emit({ type: "session_state", state: "idle", round });
          emit({
            type: "completed",
            round,
            resultSequence: current.sequence,
            result: "",
            truncated: false,
            canceled: true,
          });
          return;
        }
        const control = requireConnected();
        // Only accepted dispatch supersedes native hydration. A rejected or
        // canceled preflight must not discard a valid pending native reply.
        if (nativeInteraction) {
          rememberInteraction(nativeInteraction.id);
          nativeInteraction = undefined;
        }
        current.dispatched = true;
        const method = current.review ? "review/start" : "turn/start";
        const response = await control.request<{ turn: NativeTurn }>(method, {
          threadId,
          ...(current.review
            ? {
                target: command.runtimeParams?.review_target,
                delivery: "inline",
              }
            : { input: textInput(command.prompt) }),
        });
        if (typeof response?.turn?.id !== "string") {
          disconnect(new Error(`Incompatible Codex ${method} response`));
          throw new Error("Missing Codex turnId");
        }
        current.id = response.turn.id;
        rememberInteraction(current.id);
        emit({ type: "started", round, turnId: current.id });
        emit({
          type: "session_state",
          state: "running",
          round,
          turnId: current.id,
        });
        emit(buildStatsEvent(current));
        for (const [earlyMethod, earlyParams] of current.early.splice(0)) {
          notification(earlyMethod, earlyParams);
        }
        if (!current.finishing) await interrupt(current);
      } catch (error) {
        if (managed === current && !current.finishing) managed = undefined;
        throw error;
      } finally {
        current.releaseSubmission();
      }
    },
    async inspect() {
      if (!isConnected()) return false;
      try {
        await requireConnected().request("thread/read", {
          threadId,
          includeTurns: false,
        });
        return isConnected();
      } catch {
        return false;
      }
    },
    attachment() {
      if (attachmentPromise) return attachmentPromise;
      try {
        requireConnected();
      } catch (error) {
        return Promise.reject(error);
      }
      // A remote TUI may interact with an accepted managed turn, but must not
      // create a native turn before the managed turn/start dispatch is settled.
      const submitted = managed?.submitted;
      const launch = () => {
        requireConnected();
        attaching = true;
        return openAttachment();
      };
      const pending = (submitted ? submitted.then(launch) : launch()).finally(
        () => {
          attaching = false;
          if (attachmentPromise === pending) attachmentPromise = undefined;
        },
      );
      attachmentPromise = pending;
      return pending;
    },
    close() {
      closed = true;
      ready = false;
      closePromise ??= (async () => {
        await startPromise?.catch(() => {});
        await attachmentPromise?.catch(() => {});
        await cleanup();
      })().catch((error) => {
        closePromise = undefined;
        throw error;
      });
      return closePromise;
    },
  };
}

export function createCodexRuntime(
  dependencies: Partial<CodexDependencies> = {},
) {
  const deps: CodexDependencies = { ...defaults, ...dependencies };
  return {
    id: "codex" as const,
    displayName: "Codex",
    capabilities,
    parseConfig: parseCodexConfig,
    parseCallConfig: parseCodexCallConfig,
    parseTask: parseCodexTask,
    validate: validateCodexOptions,
    create(options: RuntimeOptions, host: RuntimeHost): RuntimeSession {
      const config = codexConfig(options);
      validateCodexOptions(options, config);
      return createCodexSession(
        { ...options, runtimeConfig: config },
        config,
        host,
        deps,
      );
    },
  } satisfies AgentRuntime;
}
