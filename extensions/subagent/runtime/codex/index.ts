import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TerminalHandle, TerminalStartError } from "../../mux/index.ts";
import { RuntimeTaskRejectedError } from "../errors.ts";
import type {
  AgentRuntime,
  RuntimeCallConfig,
  RuntimeCapabilities,
  RuntimeCommand,
  RuntimeHost,
  RuntimeOptions,
  RuntimeSession,
} from "../index.ts";
import {
  codexConfig,
  codexNativeArgs,
  parseCodexCallConfig,
  parseCodexConfig,
  parseCodexTask,
} from "./config.ts";
import { spawnCodexGuardian } from "./guardian.ts";
import {
  CODEX_REQUEST_TIMEOUT_MS,
  type CodexRpc,
  CodexTransport,
} from "./transport.ts";

const capabilities: RuntimeCapabilities = Object.freeze({
  nativeClone: false,
  steer: true,
  retainedSession: true,
  concurrentNativeInput: true,
});
const RESULT_LIMIT = 64 * 1024;
const efforts: Record<string, string> = {
  off: "none",
  none: "none",
  minimal: "minimal",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
};
function effort(options: RuntimeOptions): string | undefined {
  const value = options.agent?.thinking ?? options.thinking;
  return value === undefined ? undefined : efforts[value];
}
function bounded(
  text: string,
  limit = RESULT_LIMIT,
): { text: string; truncated: boolean } {
  const bytes = Buffer.from(text);
  if (bytes.length <= limit) return { text, truncated: false };
  let end = limit;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return { text: bytes.subarray(0, end).toString("utf8"), truncated: true };
}
const input = (text: string) => [{ type: "text", text, text_elements: [] }];
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

/** Injectable OS/transport boundary: tests never invoke a real model or CLI. */
export interface CodexDependencies {
  probe(executable: string, cwd: string, timeoutMs: number): Promise<string>;
  address(): Promise<string>;
  removeDirectory(path: string): Promise<void>;
  spawn(executable: string, argv: string[], cwd: string): ChildProcess;
  connect(
    url: string,
    token: string,
    notification: (method: string, params: Record<string, unknown>) => void,
    disconnected: (error: Error) => void,
    connectTimeoutMs: number,
    requestTimeoutMs: number,
    shouldRejectServerRequest: () => boolean | Promise<boolean>,
  ): Promise<CodexRpc>;
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
  connect: (
    url,
    token,
    notification,
    disconnected,
    connectTimeoutMs,
    requestTimeoutMs,
    shouldRejectServerRequest,
  ) =>
    CodexTransport.connect(
      url,
      token,
      notification,
      disconnected,
      connectTimeoutMs,
      undefined,
      requestTimeoutMs,
      shouldRejectServerRequest,
    ),
};

export class CodexRuntime implements AgentRuntime {
  readonly id = "codex" as const;
  readonly displayName = "Codex";
  readonly capabilities = capabilities;
  private dependencies: CodexDependencies;
  constructor(dependencies: Partial<CodexDependencies> = {}) {
    this.dependencies = { ...defaults, ...dependencies };
  }
  parseConfig(config: Record<string, unknown>): Record<string, unknown> {
    return parseCodexConfig(config);
  }
  parseCallConfig(
    config: Record<string, unknown>,
    sessionConfig: Record<string, unknown>,
    phase: "spawn" | "resume",
  ): RuntimeCallConfig {
    return parseCodexCallConfig(config, sessionConfig, phase);
  }
  parseTask(command: RuntimeCommand, options: RuntimeOptions): RuntimeCommand {
    return parseCodexTask(command, options);
  }
  validate(options: RuntimeOptions): void {
    codexConfig(options);
    if (options.parentSession) {
      throw new Error(
        "Codex cannot clone a Pi parentSession; use an explicit prompt",
      );
    }
    const thinking = options.agent?.thinking ?? options.thinking;
    if (thinking !== undefined && !Object.hasOwn(efforts, thinking))
      throw new Error(`Unsupported Codex thinking effort: ${thinking}`);
    if (
      options.startupTimeoutMs !== undefined &&
      (!Number.isFinite(options.startupTimeoutMs) ||
        options.startupTimeoutMs <= 0)
    )
      throw new Error("Invalid Codex startup timeout");
  }
  create(options: RuntimeOptions, host: RuntimeHost): RuntimeSession {
    this.validate(options);
    return new CodexSession(
      { ...options, runtimeConfig: codexConfig(options) },
      host,
      this.dependencies,
    );
  }
}

type ManagedTurn = {
  round: number;
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

class CodexSession implements RuntimeSession {
  readonly capabilities = capabilities;
  private rpc?: CodexRpc;
  private child?: ChildProcess;
  private dir?: string;
  private url = "";
  private token = "";
  private threadId?: string;
  private runtimeSessionId?: string;
  private ready = false;
  private closed = false;
  private lost = false;
  private startPromise?: Promise<void>;
  private closePromise?: Promise<void>;
  private cleanupTail: Promise<void> = Promise.resolve();
  private nativeTerminal?: TerminalHandle;
  private attaching = false;
  private attachmentPromise?: Promise<TerminalHandle>;
  private managed?: ManagedTurn;
  private nativeTurnId?: string;
  private round = 0;
  private latestUsage?: NativeUsage;
  private systemPrompt: string;
  constructor(
    private options: RuntimeOptions,
    private host: RuntimeHost,
    private deps: CodexDependencies,
  ) {
    this.systemPrompt = options.agent?.systemPrompt ?? "";
  }
  get connected(): boolean {
    return this.ready && !this.closed && !this.lost;
  }
  get terminal(): TerminalHandle | undefined {
    return this.nativeTerminal;
  }
  private emit(type: string, fields: Record<string, unknown> = {}): void {
    this.host.emit({
      type,
      threadId: this.threadId,
      runtimeSessionId: this.runtimeSessionId,
      ...fields,
    });
  }
  start(): Promise<void> {
    if (this.closed) return Promise.reject(new Error("Codex session closed"));
    this.startPromise ??= this.startBackend();
    return this.startPromise;
  }
  private async startBackend(): Promise<void> {
    const deadline = Date.now() + (this.options.startupTimeoutMs ?? 15_000);
    const remaining = () => {
      if (this.closed || this.lost) throw new Error("Codex startup aborted");
      const ms = deadline - Date.now();
      if (ms <= 0) throw new Error("Codex startup timed out");
      return ms;
    };
    try {
      const version = await this.deps.probe(
        this.options.executable ?? "codex",
        this.options.cwd,
        remaining(),
      );
      if (!/\bcodex-cli 0\.160\.0\b/.test(version))
        throw new Error("Codex runtime requires tested CLI/protocol 0.160.0");
      remaining();
      this.dir = await mkdtemp(join(tmpdir(), "pi-kits-codex-"));
      await chmod(this.dir, 0o700);
      this.token = randomBytes(32).toString("hex");
      const tokenFile = join(this.dir, "token");
      await writeFile(tokenFile, this.token, { mode: 0o600 });
      await chmod(tokenFile, 0o600);
      this.url = await this.deps.address();
      remaining();
      this.child = this.deps.spawn(
        this.options.executable ?? "codex",
        [
          "app-server",
          "--listen",
          this.url,
          "--ws-auth",
          "capability-token",
          "--ws-token-file",
          tokenFile,
          ...codexNativeArgs(codexConfig(this.options)),
        ],
        this.options.cwd,
      );
      // Drain diagnostics without retaining or forwarding secrets/unbounded output.
      this.child.stdout?.resume();
      this.child.stderr?.resume();
      this.child.on("error", () =>
        this.disconnect(new Error("Codex app-server process error")),
      );
      this.child.on("exit", (code, signal) =>
        this.disconnect(
          new Error(`Codex app-server exited (${code ?? signal})`),
        ),
      );
      while (!this.rpc) {
        try {
          this.rpc = await this.deps.connect(
            this.url,
            this.token,
            (method, params) => this.notification(method, params),
            (error) => this.disconnect(error),
            Math.min(1000, remaining()),
            CODEX_REQUEST_TIMEOUT_MS,
            () => this.shouldRejectServerRequest(),
          );
        } catch {
          remaining();
          await new Promise((resolve) => setTimeout(resolve, 40));
        }
      }
      const initialized = await this.startupRequest(
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
      if (typeof initialized?.userAgent !== "string")
        throw new Error("Incompatible Codex initialize response");
      this.rpc.notify("initialized");
      const configuredEffort = effort(this.options);
      const model = this.options.agent?.model ?? this.options.model;
      if (configuredEffort !== undefined) {
        let cursor: string | undefined;
        let selected: ModelEntry | undefined;
        for (let page = 0; page < 16; page++) {
          const catalog = await this.startupRequest(
            "model/list",
            { includeHidden: true, limit: 100, cursor },
            remaining(),
          );
          if (!Array.isArray(catalog?.data))
            throw new Error("Incompatible Codex model catalog");
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
      const config: Record<string, unknown> = {};
      if (configuredEffort !== undefined)
        config.model_reasoning_effort = configuredEffort;
      // Native review delegates disable web search even when the thread enables it.
      if (codexConfig(this.options).runtime_args.includes("search"))
        config.web_search = "live";
      const started = await this.startupRequest(
        "thread/start",
        {
          cwd: this.options.cwd,
          model,
          sandbox: "workspace-write",
          approvalPolicy: "never",
          developerInstructions: this.systemPrompt || undefined,
          ...(Object.keys(config).length ? { config } : {}),
        },
        remaining(),
      );
      if (typeof started?.thread?.id !== "string")
        throw new Error("Incompatible Codex thread/start response");
      remaining();
      this.threadId = started.thread.id;
      this.runtimeSessionId = started.thread.sessionId ?? started.thread.id;
      if (this.options.sessionName) {
        await this.startupRequest(
          "thread/name/set",
          { threadId: this.threadId, name: this.options.sessionName },
          remaining(),
        );
      }
      this.ready = true;
      this.emit("model_select", {
        provider: started.modelProvider,
        model: started.model,
        thinkingLevel: started.reasoningEffort,
      });
      this.emit("session_state", {
        state: "idle",
        sessionPath: started.thread.path ?? undefined,
      });
    } catch (error) {
      this.disconnect(
        error instanceof Error ? error : new Error("Codex startup failed"),
      );
      await this.cleanup();
      throw error;
    }
  }
  private async startupRequest(
    method: string,
    params: unknown,
    ms: number,
  ): Promise<StartupResponse> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const rpc = this.rpc;
    if (!rpc) throw new Error("Codex startup transport missing");
    try {
      return await Promise.race([
        rpc.request<StartupResponse>(method, params),
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
  }
  private disconnect(error: Error): void {
    if (this.closed || this.lost) return;
    this.lost = true;
    this.ready = false;
    this.emit("disconnected", {
      error: error.message,
      round: this.managed?.round,
    });
    // The manager owns disconnect cleanup for every session state. Retain
    // handles until close() succeeds so failures remain retryable.
  }
  private requireConnected(): CodexRpc {
    if (!this.connected || !this.rpc)
      throw new Error("Codex session is disconnected; start a new session");
    return this.rpc;
  }
  private async nativeAlive(): Promise<boolean> {
    if (this.attaching) return true;
    if (!this.nativeTerminal) return false;
    const terminal = this.nativeTerminal;
    const { alive } = await this.host.mux.inspect(terminal);
    if (!alive && this.nativeTerminal === terminal) {
      await this.host.mux.destroy(terminal);
      if (this.nativeTerminal === terminal) this.nativeTerminal = undefined;
    }
    return alive;
  }
  private shouldRejectServerRequest(): boolean | Promise<boolean> {
    const headless = () =>
      this.connected &&
      Boolean(this.managed?.dispatched && !this.managed.finishing);
    if (!headless()) return false;
    if (!this.nativeTerminal && !this.attaching) return true;
    // App-server broadcasts requests to native clients too. Never race their
    // answer, but resume headless rejection if the native terminal has exited.
    return this.nativeAlive().then((alive) => headless() && !alive);
  }
  private async preflightNativeAlive(): Promise<boolean> {
    try {
      return await this.nativeAlive();
    } catch (cause) {
      throw new RuntimeTaskRejectedError(
        "Native Codex terminal inspection/cleanup failed",
        { cause },
      );
    }
  }
  private async exclusiveCheck(): Promise<void> {
    if (await this.preflightNativeAlive())
      throw new RuntimeTaskRejectedError(
        "Exit the native Codex TUI before submitting a managed task/resume",
      );
    const { thread } = await this.requireConnected().request<StartupResponse>(
      "thread/read",
      { threadId: this.threadId, includeTurns: false },
    );
    if (!thread || thread.status?.type !== "idle")
      throw new RuntimeTaskRejectedError(
        "Codex thread is not idle; wait for the native turn to finish",
      );
    if (typeof thread.model === "string")
      this.emit("model_select", {
        model: thread.model,
        provider: thread.modelProvider,
        thinkingLevel: thread.reasoningEffort,
      });
    // Final asynchronous inspector, immediately followed by the synchronous RPC send.
    if (await this.preflightNativeAlive())
      throw new RuntimeTaskRejectedError(
        "Exit the native Codex TUI before submitting a managed task/resume",
      );
  }
  async send(command: RuntimeCommand): Promise<void> {
    try {
      command = parseCodexTask(command, this.options);
    } catch (cause) {
      throw new RuntimeTaskRejectedError(
        cause instanceof Error ? cause.message : "Invalid Codex task",
        { cause },
      );
    }
    const rpc = this.requireConnected();
    if (command.type === "cancel") {
      const managed = this.managed;
      if (
        !managed ||
        (command.round !== undefined && command.round !== managed.round)
      )
        return;
      managed.cancel = true;
      await this.interrupt(managed);
      return;
    }
    if (command.type === "steer") {
      const managed = this.managed;
      if (
        !managed?.id ||
        managed.finishing ||
        (command.round !== undefined && command.round !== managed.round)
      )
        throw new Error("No matching managed Codex turn to steer");
      await rpc.request("turn/steer", {
        threadId: this.threadId,
        expectedTurnId: managed.id,
        input: input(command.message),
      });
      return;
    }
    if (
      command.instructions?.systemPrompt !== undefined &&
      command.instructions.systemPrompt !== this.systemPrompt
    )
      throw new RuntimeTaskRejectedError(
        "Codex developerInstructions are fixed at thread creation; supply agent.systemPrompt",
      );
    if (Buffer.byteLength(command.prompt) > RESULT_LIMIT)
      throw new RuntimeTaskRejectedError("Codex task exceeds 64 KiB");
    if (this.managed || this.attachmentPromise)
      throw new RuntimeTaskRejectedError(
        "Codex managed task or native attachment already in progress",
      );
    const round = command.round ?? this.round + 1;
    if (!Number.isSafeInteger(round) || round <= this.round)
      throw new RuntimeTaskRejectedError("Invalid Codex managed round");
    let releaseSubmission!: () => void;
    const submitted = new Promise<void>((resolve) => {
      releaseSubmission = resolve;
    });
    const managed: ManagedTurn = {
      round,
      submitted,
      releaseSubmission,
      cancel: false,
      interruptSent: false,
      dispatched: false,
      finishing: false,
      early: [],
      final: "",
      review: codexConfig(this.options).runtime_args.includes("review"),
      fallback: "",
      truncated: false,
      items: new Set(),
      tools: 0,
      compactions: 0,
      baseline: { ...this.latestUsage?.total },
    };
    this.managed = managed; // Attachments wait until turn/start has settled.
    try {
      await this.exclusiveCheck();
      managed.baseline = { ...this.latestUsage?.total };
      this.round = round;
      if (managed.cancel) {
        this.managed = undefined;
        this.stats(managed);
        this.emit("session_state", { state: "idle", round });
        this.emit("completed", {
          round,
          result: "",
          truncated: false,
          canceled: true,
        });
        return;
      }
      const control = this.requireConnected();
      managed.dispatched = true;
      const method = managed.review ? "review/start" : "turn/start";
      const response = await control.request<{
        turn: NativeTurn;
      }>(method, {
        threadId: this.threadId,
        ...(managed.review
          ? { target: command.runtimeParams?.review_target, delivery: "inline" }
          : { input: input(command.prompt) }),
      });
      if (typeof response?.turn?.id !== "string") {
        this.disconnect(new Error(`Incompatible Codex ${method} response`));
        throw new Error("Missing Codex turnId");
      }
      managed.id = response.turn.id;
      this.emit("started", { round, turnId: managed.id });
      this.emit("session_state", {
        state: "running",
        round,
        turnId: managed.id,
      });
      this.stats(managed);
      for (const [method, params] of managed.early.splice(0))
        this.notification(method, params);
      if (!managed.finishing) await this.interrupt(managed);
    } catch (error) {
      if (this.managed === managed && !managed.finishing)
        this.managed = undefined;
      throw error;
    } finally {
      managed.releaseSubmission();
    }
  }
  private async interrupt(managed: ManagedTurn): Promise<void> {
    if (
      !managed.cancel ||
      !managed.id ||
      managed.interruptSent ||
      managed.finishing
    )
      return;
    managed.interruptSent = true;
    await this.requireConnected().request("turn/interrupt", {
      threadId: this.threadId,
      turnId: managed.id,
    });
    // Only turn/completed(status=interrupted) confirms cancellation.
  }
  private notification(method: string, raw: Record<string, unknown>): void {
    const params = raw as NativeEvent;
    if (!params || params.threadId !== this.threadId || !this.connected) return;
    if (method === "thread/tokenUsage/updated" && params.tokenUsage)
      this.latestUsage = params.tokenUsage;
    const managed = this.managed;
    const turnId = params.turnId ?? params.turn?.id;
    if (managed?.id && turnId && turnId !== managed.id) {
      if (method === "turn/started") this.nativeTurnId = turnId;
      if (method === "turn/completed" && this.nativeTurnId === turnId)
        this.nativeTurnId = undefined;
    }
    if (method === "thread/status/changed" && params.status?.type === "idle")
      this.nativeTurnId = undefined;
    if (!managed) {
      if (method === "thread/status/changed")
        this.emit("session_state", {
          state: params.status?.type === "active" ? "interactive" : "idle",
          activity:
            params.status?.type === "active" ? "Native Codex turn" : undefined,
        });
      return;
    }
    if (method === "runtime/blocked") {
      this.emit("blocked", {
        round: managed.round,
        turnId,
        requestMethod: params.requestMethod,
        error: "Interactive Codex request rejected by headless runtime",
      });
      this.emit("activity", {
        round: managed.round,
        toolName: params.requestMethod,
        event: "blocked",
      });
      return;
    }
    if (!managed.id) {
      if (
        !turnId ||
        ![
          "turn/started",
          "turn/completed",
          "item/started",
          "item/completed",
          "thread/tokenUsage/updated",
        ].includes(method)
      )
        return;
      if (managed.early.length >= 64) {
        this.disconnect(new Error("Codex startup event buffer exceeded"));
        return;
      }
      managed.early.push([method, raw]);
      return;
    }
    if (turnId !== managed.id || managed.finishing) return; // Native turns never belong to a managed round.
    if (method === "item/started" || method === "item/completed") {
      this.cacheItem(managed, params.item);
      const tool = params.item?.type;
      if (
        tool &&
        ![
          "agentMessage",
          "userMessage",
          "reasoning",
          "enteredReviewMode",
          "exitedReviewMode",
        ].includes(tool)
      )
        this.emit("activity", {
          round: managed.round,
          turnId,
          toolName: tool,
          event:
            method === "item/started"
              ? "tool_execution_start"
              : "tool_execution_end",
        });
    }
    if (method === "thread/tokenUsage/updated") {
      managed.usage = params.tokenUsage;
      this.stats(managed);
    }
    if (method === "turn/completed" && params.turn) {
      managed.finishing = true;
      void this.complete(managed, params.turn).catch((error) =>
        this.disconnect(error),
      );
    }
  }
  private cacheItem(managed: ManagedTurn, item: NativeItem | undefined): void {
    if (!item || typeof item.id !== "string") return;
    if (!managed.items.has(item.id)) {
      if (managed.items.size >= 4096)
        throw new Error("Codex managed item limit exceeded");
      managed.items.add(item.id);
      if (
        [
          "commandExecution",
          "fileChange",
          "mcpToolCall",
          "dynamicToolCall",
          "collabAgentToolCall",
          "webSearch",
          "imageGeneration",
        ].includes(item.type)
      )
        managed.tools++;
      if (item.type === "contextCompaction") managed.compactions++;
    }
    if (item.type === "exitedReviewMode" && typeof item.review === "string") {
      const result = bounded(item.review);
      managed.reviewResult = result.text;
      managed.truncated ||= result.truncated;
    }
    if (item.type === "agentMessage" && typeof item.text === "string") {
      const result = bounded(item.text);
      if (item.phase === "final_answer") managed.final = result.text;
      else managed.fallback = result.text;
      managed.truncated ||= result.truncated;
    }
  }
  private stats(managed: ManagedTurn): void {
    const delta: Record<string, number> = {};
    for (const [key, value] of Object.entries(managed.usage?.total ?? {})) {
      if (Number.isSafeInteger(value) && value >= 0)
        delta[key] = Math.max(0, value - (managed.baseline[key] ?? 0));
    }
    const totalTokens =
      Math.max(0, (delta.inputTokens ?? 0) - (delta.cachedInputTokens ?? 0)) +
      (delta.outputTokens ?? 0);
    this.emit("stats", {
      round: managed.round,
      turnId: managed.id,
      turnCount: managed.finishing ? 1 : 0,
      toolUses: managed.tools,
      compactionCount: managed.compactions,
      totalTokens,
      usage: managed.usage ? { ...managed.usage, delta } : undefined,
    });
  }
  private async complete(
    managed: ManagedTurn,
    turn: NativeTurn,
  ): Promise<void> {
    for (const item of turn.items ?? []) this.cacheItem(managed, item);
    let hydrationError: string | undefined;
    if (
      turn.itemsView !== "full" &&
      (managed.review ? managed.reviewResult === undefined : !managed.final)
    ) {
      try {
        let cursor: string | undefined;
        const cursors = new Set<string>();
        for (let page = 0; page < 64; page++) {
          const result = await this.requireConnected().request<{
            data: Array<{ item: NativeItem }>;
            nextCursor?: string | null;
          }>("thread/items/list", {
            threadId: this.threadId,
            turnId: managed.id,
            limit: 100,
            sortDirection: "asc",
            cursor,
          });
          if (!Array.isArray(result?.data))
            throw new Error("Invalid Codex item page");
          for (const entry of result.data) this.cacheItem(managed, entry.item);
          if (!result.nextCursor) break;
          if (cursors.has(result.nextCursor) || page === 63)
            throw new Error("Codex item pagination limit exceeded");
          cursors.add(result.nextCursor);
          cursor = result.nextCursor;
        }
      } catch (error) {
        hydrationError =
          error instanceof Error
            ? error.message
            : "Codex item hydration failed";
      }
    }
    if (this.managed !== managed || !this.connected) return;
    this.stats(managed);
    this.managed = undefined;
    this.emit("session_state", {
      state: this.nativeTurnId ? "interactive" : "idle",
      activity: this.nativeTurnId ? "Native Codex turn" : undefined,
      round: managed.round,
      turnId: managed.id,
    });
    this.emit("completed", {
      round: managed.round,
      turnId: managed.id,
      result: managed.reviewResult ?? (managed.final || managed.fallback),
      truncated: managed.truncated,
      canceled: turn.status === "interrupted",
      error:
        turn.status === "failed"
          ? String(turn.error?.message ?? "Codex turn failed")
          : hydrationError,
    });
  }
  async inspect(): Promise<boolean> {
    if (!this.connected) return false;
    try {
      await this.requireConnected().request("thread/read", {
        threadId: this.threadId,
        includeTurns: false,
      });
      return this.connected;
    } catch {
      return false;
    }
  }
  attachment(): Promise<TerminalHandle> {
    if (this.attachmentPromise) return this.attachmentPromise;
    try {
      this.requireConnected();
    } catch (error) {
      return Promise.reject(error);
    }
    // A remote TUI may interact with an accepted managed turn, but must not
    // create a native turn before the managed turn/start dispatch is settled.
    const submitted = this.managed?.submitted;
    const launch = () => {
      this.requireConnected();
      this.attaching = true;
      return this.openAttachment();
    };
    const pending = (submitted ? submitted.then(launch) : launch()).finally(
      () => {
        this.attaching = false;
        if (this.attachmentPromise === pending)
          this.attachmentPromise = undefined;
      },
    );
    this.attachmentPromise = pending;
    return pending;
  }
  private async openAttachment(): Promise<TerminalHandle> {
    try {
      if (this.nativeTerminal) {
        if ((await this.host.mux.inspect(this.nativeTerminal)).alive) {
          this.requireConnected();
          return this.nativeTerminal;
        }
        const previous = this.nativeTerminal;
        await this.host.mux.destroy(previous);
        if (this.nativeTerminal === previous) this.nativeTerminal = undefined;
      }
      this.requireConnected();
      const threadId = this.threadId;
      if (!threadId) throw new Error("Codex attachment thread missing");
      const terminal = await this.host.mux.start({
        agentId: this.options.id,
        cwd: this.options.cwd,
        argv: [
          this.options.executable ?? "codex",
          "--remote",
          this.url,
          "--remote-auth-token-env",
          "PI_KITS_CODEX_TOKEN",
          "resume",
          threadId,
        ],
        env: { PI_KITS_CODEX_TOKEN: this.token, PI_KITS_SUBAGENT_WORKER: "1" },
      });
      // Take ownership before checking lifecycle state: even a late terminal
      // must remain available to close(), including when destroy fails.
      this.nativeTerminal = terminal;
      if (!this.connected)
        throw new Error(
          "Codex session closed or disconnected during attachment",
        );
      return terminal;
    } catch (error) {
      if (error instanceof TerminalStartError) {
        this.nativeTerminal = error.terminal;
        // An in-flight close waits for us and owns cleanup/error propagation.
        if (!this.closed) {
          await this.host.mux.destroy(error.terminal);
          if (this.nativeTerminal === error.terminal)
            this.nativeTerminal = undefined;
        }
      }
      throw error;
    }
  }
  close(): Promise<void> {
    this.closed = true;
    this.ready = false;
    this.closePromise ??= (async () => {
      await this.startPromise?.catch(() => {});
      await this.attachmentPromise?.catch(() => {});
      await this.cleanup();
    })().catch((error) => {
      this.closePromise = undefined;
      throw error;
    });
    return this.closePromise;
  }
  private cleanup(): Promise<void> {
    const next = this.cleanupTail
      .catch(() => {})
      .then(() => this.cleanupResources());
    this.cleanupTail = next;
    return next;
  }
  private async cleanupResources(): Promise<void> {
    const rpc = this.rpc;
    this.rpc = undefined;
    rpc?.close();
    const child = this.child;
    if (child && child.exitCode === null && child.signalCode === null) {
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
          child.removeListener("exit", exited);
          reject(cause);
        };
        child.once("exit", exited);
        timer = setTimeout(() => {
          timer = setTimeout(
            () =>
              failed(new Error("Codex guardian exit unconfirmed; retry close")),
            500,
          );
          try {
            child.kill("SIGKILL");
          } catch (cause) {
            failed(cause);
          }
        }, 500);
        try {
          child.kill("SIGTERM");
        } catch (cause) {
          failed(cause);
        }
      });
    }
    // Retain child, credentials and directory on an unconfirmed stop so the
    // manager cannot release its concurrency claim and retries keep ownership.
    if (this.child === child) this.child = undefined;
    const terminal = this.nativeTerminal;
    let terminalError: unknown;
    if (terminal) {
      try {
        await this.host.mux.destroy(terminal);
        if (this.nativeTerminal === terminal) this.nativeTerminal = undefined;
      } catch (error) {
        terminalError = error;
      }
    }
    const dir = this.dir;
    if (dir) {
      await this.deps.removeDirectory(dir);
      this.dir = undefined;
    }
    this.token = "";
    if (terminalError) throw terminalError;
  }
}
