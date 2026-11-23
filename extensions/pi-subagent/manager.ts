import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  SUBAGENT_DEFAULT_EXTENSIONS,
  type WorkerExtensionSource,
} from "@pi-kits/config";
import {
  captureParentSession,
  createClonedSession,
  type ParentSessionSnapshot,
} from "./clone.ts";
import { type AgentDefinition, resolveWorkerExtensions } from "./config.ts";
import type { Executor, TerminalHandle, ViewHandle } from "./execute/index.ts";
import { createSerializer } from "./util.ts";
import {
  isBackendSessionState,
  MAX_COMMAND_BYTES,
  MAX_RESULT_BYTES,
  type SessionUpdate,
  type WorkerCommand,
  type WorkerEvent,
  type WorkerSessionState,
} from "./worker.ts";

export type { SessionUpdate, WorkerSessionState } from "./worker.ts";
export { isBackendSessionState } from "./worker.ts";

export type AgentStatus =
  | "queued"
  | "starting"
  | "running"
  | "stopping"
  | "disconnected"
  | "completed"
  | "stopped"
  | "error";

export type SessionState = WorkerSessionState | "disconnected" | "closed";

export function isTerminalStatus(status: AgentStatus): boolean {
  return status === "completed" || status === "stopped" || status === "error";
}

export function isWorkingStatus(status: AgentStatus): boolean {
  return status === "starting" || status === "running" || status === "stopping";
}

export function isDisplayActive(agent: {
  status: AgentStatus;
  sessionState?: SessionState;
}): boolean {
  return isWorkingStatus(agent.status) || agent.sessionState === "interactive";
}

export function hasDisplayError(agent: {
  status: AgentStatus;
  sessionState?: SessionState;
}): boolean {
  return (
    agent.status === "error" ||
    agent.status === "disconnected" ||
    agent.sessionState === "disconnected"
  );
}

export function nativeViewHint(agent: {
  status: AgentStatus;
  sessionState?: SessionState;
  supportsView?: boolean;
  terminalId?: string;
}): boolean {
  if (agent.supportsView === false || agent.sessionState === "closed") {
    return false;
  }
  return Boolean(
    agent.terminalId &&
      agent.status !== "queued" &&
      agent.status !== "starting" &&
      agent.status !== "disconnected",
  );
}

export interface AgentSnapshot {
  id: string;
  description: string;
  cwd?: string;
  status: AgentStatus;
  round?: number;
  inheritedContext?: boolean;
  supportsView?: boolean;
  sessionState?: SessionState;
  sessionActivity?: string;
  subagentType?: string;
  displayName?: string;
  model?: string;
  result?: string;
  resultRevision?: number;
  error?: string;
  activity?: string;
  sessionPath?: string;
  terminalId?: string;
  viewId?: string;
  truncated?: boolean;
  createdAt?: number;
  startedAt?: number;
  completedAt?: number;
  turnCount?: number;
  toolUses?: number;
  totalTokens?: number;
  contextPercent?: number;
  compactionCount?: number;
  hint?: string;
}

export function buildNextHint(snapshot: AgentSnapshot): string {
  const id = snapshot.id;
  const suffix =
    snapshot.truncated && snapshot.sessionPath
      ? ` Output was truncated; full transcript is at ${snapshot.sessionPath}.`
      : "";
  if (snapshot.sessionState === "interactive") {
    return `User is currently interacting in the native terminal. Wait for user interaction to settle before sending new instructions.${suffix}`;
  }
  if (
    snapshot.status === "queued" ||
    snapshot.status === "starting" ||
    snapshot.status === "running"
  ) {
    return `Running in background; completion will be delivered automatically. To wait now: subagent_ctl({ id: "${id}", action: "wait" }). To steer: subagent({ id: "${id}", prompt: "..." }).${suffix}`;
  }
  if (snapshot.status === "stopping") {
    return `Cancellation is in progress. Call subagent_ctl({ id: "${id}", action: "wait" }) to await settlement.${suffix}`;
  }
  if (
    snapshot.status === "disconnected" ||
    snapshot.sessionState === "disconnected"
  ) {
    return `Worker cleanup failed; retry with subagent_ctl({ id: "${id}", action: "stop" }).${suffix}`;
  }
  if (snapshot.status === "completed") {
    return `Task completed. To continue in this same session (preserving full history): subagent({ id: "${id}", prompt: "..." }).${suffix}`;
  }
  return `Round ended (${snapshot.status}). You can continue or recover in this same session via subagent({ id: "${id}", prompt: "..." }).${suffix}`;
}

export interface SpawnOptions {
  prompt: string;
  description?: string;
  cwd: string;
  sessionName?: string;
  model?: string;
  thinking?: string;
  agent?: AgentDefinition;
  context?: unknown;
  parentSession?: ParentSessionSnapshot;
}

export interface SendOptions {
  prompt: string;
  description?: string;
}

export interface ManagerOptions {
  maxConcurrent?: number;
  startupTimeoutMs?: number;
  cancelTimeoutMs?: number;
  extensionAllowlist?: readonly WorkerExtensionSource[];
  workerPath?: string;
  executable?: string;
  onComplete?: (snapshot: AgentSnapshot) => void;
  onSessionUpdate?: (snapshot: AgentSnapshot, update: SessionUpdate) => void;
}

export interface SubagentManager {
  subscribe(listener: () => void): () => void;
  list(): AgentSnapshot[];
  get(id: string): AgentSnapshot;
  spawn(options: SpawnOptions): AgentSnapshot;
  backgroundPreference(id: string): boolean | undefined;
  send(id: string, options: SendOptions): Promise<AgentSnapshot>;
  result(
    id: string,
    wait?: boolean,
    signal?: AbortSignal,
  ): Promise<AgentSnapshot>;
  stop(id: string): AgentSnapshot;
  openView(id: string): Promise<ViewHandle>;
  closeView(id: string): Promise<void>;
  remove(id: string): Promise<void>;
  close(): Promise<void>;
}

// ============================================================================
// ECS / Data-Driven Entity & Component Model (Zero Stored State Enums)
// ============================================================================

interface StatsData {
  turnCount: number;
  toolUses: number;
  totalTokens: number;
  compactionCount: number;
  contextPercent?: number;
}

interface ReplyData {
  text: string;
  revision: number;
  truncated: boolean;
  sequence: number;
}

/** Component 1: Live OS/Worker Process Attachment (exists only while a process is allocated). */
interface WorkerComponent {
  readonly session: WorkerSession;
  view?: ViewHandle;
  interactiveActivity?: string;
  cleanupError?: string;
  closing?: Promise<void>;
}

/** Component 2: Active Managed Turn (exists only while a round is queued, starting, or running). */
interface TurnComponent {
  readonly round: number;
  command: WorkerCommand;
  readonly createdAt: number;
  startedAt?: number;
  launching?: Promise<void>;
  dispatched: boolean;
  canceling: boolean;
  cancelTimer?: ReturnType<typeof setTimeout>;
  activity?: string;
  stats: StatsData;
  waiters: number;
  readonly completion: Promise<AgentSnapshot>;
  readonly resolve: (snapshot: AgentSnapshot) => void;
}

/** Component 3: Last Settled Round Outcome (exists after at least one round has finished). */
interface SettledComponent {
  readonly round: number;
  readonly outcome: "completed" | "stopped" | "error";
  readonly error?: string;
  readonly createdAt: number;
  readonly startedAt?: number;
  readonly completedAt: number;
  readonly stats: StatsData;
  consumed: boolean;
  notified: boolean;
}

/** The Entity: pure data components, no stored `status` or `sessionState` enums. */
interface SubagentEntity {
  readonly id: string;
  readonly sessionKey: string;
  description: string;
  options: SpawnOptions;
  sessionPath?: string;
  model?: string;
  worker?: WorkerComponent;
  turn?: TurnComponent;
  settled?: SettledComponent;
  reply?: ReplyData;
  lastInteractionSeq: number;
}

// ============================================================================
// Pure Derived State Queries (Status & SessionState are 100% derived from data)
// ============================================================================

function deriveStatus(e: SubagentEntity): AgentStatus {
  if (e.worker?.cleanupError && e.turn) return "disconnected";
  if (e.turn) {
    if (e.turn.canceling) return "stopping";
    if (e.turn.dispatched) return "running";
    if (e.turn.launching || e.turn.startedAt !== undefined) return "starting";
    return "queued";
  }
  return e.settled?.outcome ?? "queued";
}

function deriveSessionState(e: SubagentEntity): SessionState | undefined {
  if (e.worker?.cleanupError) return "disconnected";
  if (e.worker) {
    if (e.worker.interactiveActivity !== undefined) return "interactive";
    if (e.turn?.dispatched) return "running";
    if (e.worker.session.connected) return "idle";
    return undefined;
  }
  return e.settled ? "closed" : undefined;
}

function deriveSnapshot(
  e: SubagentEntity,
  supportsView: boolean,
): AgentSnapshot {
  const status = deriveStatus(e);
  const sessionState = deriveSessionState(e);
  const activeStats = e.turn?.stats ??
    e.settled?.stats ?? {
      turnCount: 0,
      toolUses: 0,
      totalTokens: 0,
      compactionCount: 0,
    };
  const snap: AgentSnapshot = {
    id: e.id,
    description: e.description,
    cwd: e.options.cwd,
    status,
    round: e.turn?.round ?? e.settled?.round ?? 1,
    inheritedContext: Boolean(e.options.parentSession),
    supportsView,
    ...(sessionState !== undefined ? { sessionState } : {}),
    ...(e.worker?.cleanupError
      ? {
          sessionActivity: `Worker cleanup failed (${e.worker.cleanupError}); retry stop.`,
        }
      : e.worker?.interactiveActivity
        ? { sessionActivity: e.worker.interactiveActivity }
        : {}),
    model: e.options.agent?.model ?? e.model ?? e.options.model,
    ...(e.options.agent
      ? {
          subagentType: e.options.agent.name,
          displayName: e.options.agent.displayName,
        }
      : {}),
    ...(e.reply
      ? {
          result: e.reply.text,
          resultRevision: e.reply.revision,
          truncated: e.reply.truncated,
        }
      : {}),
    ...(e.worker?.cleanupError && e.turn
      ? {
          error: `Worker cleanup failed (${e.worker.cleanupError}); concurrency slot retained. Retry stop.`,
        }
      : !e.turn && e.settled?.error
        ? { error: e.settled.error }
        : {}),
    ...(e.turn?.activity ? { activity: e.turn.activity } : {}),
    ...(e.sessionPath ? { sessionPath: e.sessionPath } : {}),
    terminalId:
      sessionState === "closed" ? undefined : e.worker?.session.terminal?.id,
    viewId: e.worker?.view?.id,
    createdAt: e.turn?.createdAt ?? e.settled?.createdAt,
    startedAt: e.turn?.startedAt ?? e.settled?.startedAt,
    completedAt: e.turn ? undefined : e.settled?.completedAt,
    turnCount: activeStats.turnCount,
    toolUses: activeStats.toolUses,
    totalTokens: activeStats.totalTokens,
    contextPercent: activeStats.contextPercent,
    compactionCount: activeStats.compactionCount,
  };
  snap.hint = buildNextHint(snap);
  return snap;
}

// ============================================================================
// Worker Process & Loopback TCP Bridge
// ============================================================================

const MAX_FRAME_BYTES = 1_048_576;

interface WorkerSession {
  readonly connected: boolean;
  readonly terminal: TerminalHandle | undefined;
  start(): Promise<void>;
  send(command: WorkerCommand): void;
  inspect(): Promise<boolean>;
  close(): Promise<void>;
}

function createTaskCommand(prompt: string, round?: number): WorkerCommand {
  if (!prompt.trim()) throw new Error("Task prompt must not be blank.");
  const command: WorkerCommand = {
    type: "task",
    prompt,
    ...(round !== undefined && round > 1 ? { round } : {}),
  };
  if (Buffer.byteLength(JSON.stringify(command)) > MAX_COMMAND_BYTES) {
    throw new Error("Subagent command exceeds the 64 KiB protocol limit.");
  }
  return command;
}

function createWorkerSession(
  entity: SubagentEntity,
  executor: Executor,
  managerOptions: ManagerOptions,
  emit: (event: WorkerEvent) => void,
): WorkerSession {
  const token = randomBytes(32).toString("hex");
  const sockets = new Set<Socket>();
  let terminal: TerminalHandle | undefined;
  let socket: Socket | undefined;
  let server: Server | undefined;
  let authenticated = false;
  let closed = false;
  let starting: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  let promptDirectory: string | undefined;
  let ready: (() => void) | undefined;
  let rejectReady: ((error: Error) => void) | undefined;

  const isConnected = () => Boolean(socket && !socket.destroyed && !closed);

  const accept = (client: Socket): void => {
    if (closed) {
      client.destroy();
      return;
    }
    sockets.add(client);
    client.setEncoding("utf8");
    client.setTimeout(10_000, () => client.destroy());
    let buffer = "";
    let clientAuthed = false;
    client.on("data", (chunk) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > MAX_FRAME_BYTES) {
        client.destroy();
        return;
      }
      for (
        let nl = buffer.indexOf("\n");
        nl !== -1;
        nl = buffer.indexOf("\n")
      ) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        try {
          const raw = JSON.parse(line) as Record<string, unknown>;
          if (!raw || typeof raw !== "object") throw new Error("Bad frame");
          if (!clientAuthed) {
            if (
              raw.type !== "ready" ||
              raw.id !== entity.id ||
              raw.token !== token ||
              authenticated ||
              closed
            ) {
              throw new Error("Worker authentication failed");
            }
            clientAuthed = true;
            authenticated = true;
            socket = client;
            client.setTimeout(0);
            emit(raw as unknown as WorkerEvent);
            ready?.();
          } else {
            if (typeof raw.type !== "string") throw new Error("Bad frame");
            emit(raw as unknown as WorkerEvent);
          }
        } catch {
          client.destroy();
          return;
        }
      }
    });
    client.on("error", () => client.destroy());
    client.on("close", () => {
      sockets.delete(client);
      if (socket !== client) return;
      socket = undefined;
      rejectReady?.(new Error("Pi worker disconnected."));
      if (!closed) {
        emit({
          type: "session_state",
          id: entity.id,
          state: "idle",
          activity: "__disconnected__",
        });
      }
    });
  };

  const launch = async (): Promise<void> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (closed) throw new Error("Pi worker is closed.");
      const extensions = await resolveWorkerExtensions(
        entity.options.agent?.extensions ??
          managerOptions.extensionAllowlist ??
          SUBAGENT_DEFAULT_EXTENSIONS,
      );
      if (closed) throw new Error("Pi worker is closed.");
      const endpoint = await new Promise<string>((resolve, reject) => {
        const listener = createServer(accept);
        server = listener;
        listener.once("error", reject);
        listener.listen(0, "127.0.0.1", () => {
          const addr = listener.address();
          if (!addr || typeof addr === "string")
            reject(new Error("Could not bind worker server."));
          else resolve(`127.0.0.1:${addr.port}`);
        });
      });
      if (closed) throw new Error("Pi worker is closed.");
      const awaitingReady = new Promise<void>((resolve, reject) => {
        ready = resolve;
        rejectReady = reject;
        timer = setTimeout(
          () => reject(new Error("Timed out waiting for the Pi worker.")),
          managerOptions.startupTimeoutMs ?? 60_000,
        );
      });
      void awaitingReady.catch(() => undefined);

      let sessionFlag: [string, string];
      if (entity.sessionPath) {
        sessionFlag = ["--session", entity.sessionPath];
      } else if (entity.options.parentSession) {
        const sessionPath = createClonedSession(
          entity.options.parentSession,
          entity.options.cwd,
          `subagent-${entity.sessionKey}`,
        );
        entity.sessionPath = sessionPath;
        sessionFlag = ["--session", sessionPath];
      } else {
        sessionFlag = ["--session-id", `subagent-${entity.sessionKey}`];
      }

      const argv = [
        managerOptions.executable ?? "pi",
        "--no-extensions",
        "-e",
        managerOptions.workerPath ??
          fileURLToPath(new URL("./worker.ts", import.meta.url)),
        ...extensions.flatMap((ext) => ["-e", ext]),
        ...sessionFlag,
      ];
      if (entity.options.sessionName)
        argv.push("--name", entity.options.sessionName);
      const model = entity.options.agent?.model ?? entity.options.model;
      const thinking =
        entity.options.agent?.thinking ?? entity.options.thinking;
      if (model) argv.push("--model", model);
      if (thinking) argv.push("--thinking", thinking);
      const tools = entity.options.agent?.tools;
      if (tools !== undefined) {
        if (tools.length) argv.push("--tools", tools.join(","));
        else argv.push("--no-tools");
      }
      if (entity.options.agent?.disallowedTools?.length) {
        argv.push(
          "--exclude-tools",
          entity.options.agent.disallowedTools.join(","),
        );
      }
      if (entity.options.agent) {
        promptDirectory = mkdtempSync(join(tmpdir(), "pi-kits-prompt-"));
        const promptPath = join(promptDirectory, "system.md");
        writeFileSync(promptPath, entity.options.agent.systemPrompt, {
          mode: 0o600,
        });
        if (entity.options.agent.promptMode === "append") {
          argv.push("--append-system-prompt", promptPath);
        } else {
          const emptyPath = join(promptDirectory, "append.md");
          writeFileSync(emptyPath, "", { mode: 0o600 });
          argv.push(
            "--system-prompt",
            promptPath,
            "--append-system-prompt",
            emptyPath,
          );
        }
      }

      terminal = await executor.start({
        agentId: entity.id,
        agentType: entity.options.agent?.name,
        cwd: entity.options.cwd,
        argv,
        env: {
          PI_KITS_SUBAGENT_WORKER: "1",
          PI_KITS_SUBAGENT_ENDPOINT: endpoint,
          PI_KITS_SUBAGENT_TOKEN: token,
          PI_KITS_SUBAGENT_ID: entity.id,
        },
      });
      if (closed) throw new Error("Pi worker is closed.");
      await awaitingReady;
      if (!isConnected()) throw new Error("Pi worker disconnected.");
    } finally {
      clearTimeout(timer);
      ready = undefined;
      rejectReady = undefined;
    }
  };

  const cleanup = async (): Promise<void> => {
    await starting?.catch(() => undefined);
    try {
      if (terminal) {
        await executor.destroy(terminal);
        terminal = undefined;
      }
      if (promptDirectory) {
        rmSync(promptDirectory, { recursive: true, force: true });
        promptDirectory = undefined;
      }
    } finally {
      socket = undefined;
      for (const client of sockets) client.destroy();
      if (server?.listening) {
        await new Promise<void>((resolve) => server?.close(() => resolve()));
      }
    }
  };

  return {
    get connected() {
      return isConnected();
    },
    get terminal() {
      return terminal;
    },
    start() {
      starting ??= launch();
      return starting;
    },
    send(command: WorkerCommand) {
      if (!isConnected()) throw new Error("Pi worker is not connected.");
      const frame = JSON.stringify(command);
      if (Buffer.byteLength(frame) > MAX_COMMAND_BYTES) {
        throw new Error("Subagent command exceeds the 64 KiB protocol limit.");
      }
      socket?.write(`${frame}\n`);
    },
    async inspect() {
      return Boolean(
        isConnected() && terminal && (await executor.inspect(terminal)).alive,
      );
    },
    close() {
      closed = true;
      rejectReady?.(new Error("Pi worker closed during startup."));
      if (closing) return closing;
      const op = cleanup();
      closing = op;
      const clear = () => {
        closing = undefined;
      };
      void op.then(clear, clear);
      return op;
    },
  };
}

// ============================================================================
// Data-Driven Coordinator & Reconcile Systems
// ============================================================================

function validText(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= 4096 &&
    !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(value)
  );
}

function createTurnComponent(
  round: number,
  command: WorkerCommand,
  now = Date.now(),
): TurnComponent {
  let resolve: (snap: AgentSnapshot) => void = () => undefined;
  const completion = new Promise<AgentSnapshot>((done) => {
    resolve = done;
  });
  return {
    round,
    command,
    createdAt: now,
    dispatched: false,
    canceling: false,
    stats: { turnCount: 0, toolUses: 0, totalTokens: 0, compactionCount: 0 },
    waiters: 0,
    completion,
    resolve,
  };
}

function prepareParentSnapshot(
  options: SpawnOptions,
): ParentSessionSnapshot | undefined {
  if (options.parentSession) return options.parentSession;
  if (!options.agent?.inheritContext) return undefined;
  const ctx = options.context;
  if (
    !ctx ||
    typeof ctx !== "object" ||
    !["getBranch", "getHeader", "getSessionFile", "getSessionDir"].every(
      (m) => typeof (ctx as Record<string, unknown>)[m] === "function",
    )
  ) {
    throw new Error(
      "inherit_context requires a valid host session context (sessionManager)",
    );
  }
  return captureParentSession(ctx as ExtensionContext["sessionManager"]);
}

export function createSubagentManager(
  executor: Executor,
  options: ManagerOptions = {},
): SubagentManager {
  const entities = new Map<string, SubagentEntity>();
  const listeners = new Set<() => void>();
  const serializeView = createSerializer();
  const supportsView =
    executor.supportsView !== false && Boolean(executor.open_view);
  let nextSequence = 1;
  let disposed = false;
  let closing: Promise<void> | undefined;

  const changed = (): void => {
    for (const listener of listeners) {
      try {
        listener();
      } catch {}
    }
  };

  const getEntity = (id: string): SubagentEntity => {
    const found = entities.get(id);
    if (!found) throw new Error(`Unknown subagent: ${id}`);
    return found;
  };

  const snap = (e: SubagentEntity): AgentSnapshot =>
    deriveSnapshot(e, supportsView);

  /** Count entities holding a concurrency slot (active launch, running turn, or uncleaned disconnect). */
  const activeSlotCount = (): number => {
    let count = 0;
    for (const e of entities.values()) {
      if (
        e.turn &&
        (e.turn.launching ||
          e.turn.dispatched ||
          e.turn.startedAt !== undefined ||
          e.worker?.cleanupError)
      ) {
        count += 1;
      }
    }
    return count;
  };

  /** Detach the TurnComponent and record a SettledComponent. */
  const settleTurn = (
    e: SubagentEntity,
    outcome: "completed" | "stopped" | "error",
    error?: string,
  ): void => {
    const turn = e.turn;
    if (!turn) return;
    clearTimeout(turn.cancelTimer);
    e.turn = undefined;
    e.settled = {
      round: turn.round,
      outcome,
      error,
      createdAt: turn.createdAt,
      startedAt: turn.startedAt,
      completedAt: Date.now(),
      stats: turn.stats,
      consumed: turn.waiters > 0,
      notified: false,
    };
    const finalSnap = snap(e);
    turn.resolve(finalSnap);
    if (!disposed && !e.settled.consumed && !e.settled.notified) {
      e.settled.notified = true;
      try {
        options.onComplete?.({ ...finalSnap });
      } catch {}
    }
    changed();
    reconcile();
  };

  /** Destroy an entity's WorkerComponent (process + view). Retains component with cleanupError if destroy fails. */
  const destroyWorker = (
    e: SubagentEntity,
    onCleaned?: () => void,
  ): Promise<void> => {
    const worker = e.worker;
    if (!worker) {
      onCleaned?.();
      return Promise.resolve();
    }
    if (worker.closing) return worker.closing;
    const op = serializeView(async () => {
      let viewErr: unknown;
      if (worker.view && executor.close_view) {
        try {
          await executor.close_view(worker.view);
          worker.view = undefined;
        } catch (err) {
          viewErr = err;
        }
      }
      let sessionErr: unknown;
      try {
        await worker.session.close();
      } catch (err) {
        sessionErr = err;
      }
      const cause = sessionErr ?? viewErr;
      if (cause) {
        worker.cleanupError =
          cause instanceof Error ? cause.message : String(cause);
        changed();
        return;
      }
      if (e.worker === worker) e.worker = undefined;
      onCleaned?.();
      changed();
      reconcile();
    });
    worker.closing = op;
    const clear = () => {
      worker.closing = undefined;
    };
    void op.then(clear, clear);
    return op;
  };

  const applyReply = (
    e: SubagentEntity,
    text: string,
    truncated: boolean,
    sequence?: number,
  ): void => {
    const seq = sequence ?? (e.reply?.sequence ?? 0) + 1;
    if (sequence !== undefined && sequence <= (e.reply?.sequence ?? 0)) return;
    if (!text) return;
    e.reply = {
      text,
      revision: (e.reply?.revision ?? 0) + 1,
      truncated,
      sequence: seq,
    };
  };

  const handleWorkerEvent = (
    e: SubagentEntity,
    session: WorkerSession,
    event: WorkerEvent,
  ): void => {
    if (e.worker?.session !== session) return;
    if (typeof event.sessionPath === "string" && event.sessionPath) {
      e.sessionPath = event.sessionPath;
    }
    if (validText(event.model)) {
      e.model = event.model;
    }

    if (event.type === "ready" || event.type === "model_select") {
      changed();
      return;
    }
    if (event.type === "session_update") {
      if (
        typeof event.interactionId !== "string" ||
        !event.interactionId.trim() ||
        !Number.isSafeInteger(event.sequence) ||
        event.sequence < 1 ||
        typeof event.response !== "string" ||
        Buffer.byteLength(event.response) > MAX_RESULT_BYTES
      ) {
        return;
      }
      if (event.sequence <= e.lastInteractionSeq || disposed) return;
      e.lastInteractionSeq = event.sequence;
      applyReply(e, event.response, event.truncated === true, event.sequence);
      changed();
      try {
        options.onSessionUpdate?.(snap(e), event);
      } catch {}
      return;
    }
    if (
      event.type === "session_state" &&
      event.activity === "__disconnected__"
    ) {
      if (e.turn && !e.turn.dispatched && e.turn.launching) return;
      const outcome = e.turn?.canceling ? "stopped" : "error";
      void destroyWorker(e, () =>
        settleTurn(e, outcome, "Pi worker disconnected."),
      );
      return;
    }
    if (event.type === "session_state") {
      if (!isBackendSessionState(event.state)) return;
      e.worker.interactiveActivity =
        event.state === "interactive"
          ? (event.activity?.slice(0, 4096) ?? "Thinking…")
          : undefined;
      changed();
      reconcile();
      return;
    }

    const turn = e.turn;
    if (!turn || (event.round !== undefined && event.round !== turn.round)) {
      return;
    }
    if (event.type === "started") {
      changed();
    } else if (event.type === "stats") {
      for (const k of [
        "turnCount",
        "toolUses",
        "totalTokens",
        "compactionCount",
      ] as const) {
        const v = event[k];
        if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) {
          turn.stats[k] = v;
        }
      }
      turn.stats.contextPercent =
        typeof event.contextPercent === "number" &&
        Number.isFinite(event.contextPercent) &&
        event.contextPercent >= 0 &&
        event.contextPercent <= 100
          ? event.contextPercent
          : undefined;
      changed();
    } else if (event.type === "activity") {
      if (typeof event.toolName === "string") {
        turn.activity =
          event.event === "tool_execution_end" ? "Thinking…" : event.toolName;
        changed();
      }
    } else if (event.type === "completed") {
      applyReply(e, event.result, event.truncated === true);
      if (event.canceled) settleTurn(e, "stopped");
      else if (event.error) settleTurn(e, "error", event.error);
      else settleTurn(e, turn.canceling ? "stopped" : "completed");
    }
  };

  /** Execute a single turn: ensure WorkerComponent is connected, then dispatch command. */
  const executeTurn = async (
    e: SubagentEntity,
    turn: TurnComponent,
  ): Promise<void> => {
    try {
      const alive =
        e.worker?.session.connected &&
        !e.worker.cleanupError &&
        (await e.worker.session.inspect());
      if (e.turn !== turn || disposed || turn.canceling) {
        await destroyWorker(e, () => settleTurn(e, "stopped"));
        return;
      }
      if (!alive) {
        if (e.worker) await destroyWorker(e);
        const session = createWorkerSession(e, executor, options, (ev) =>
          handleWorkerEvent(e, session, ev),
        );
        e.worker = { session };
        await session.start();
      }
      if (e.turn !== turn || disposed || turn.canceling) {
        await destroyWorker(e, () => settleTurn(e, "stopped"));
        return;
      }
      if (!e.worker?.session.connected) {
        throw new Error("Subagent runtime disconnected during startup.");
      }
      if (e.worker.interactiveActivity !== undefined) {
        settleTurn(
          e,
          "error",
          "Subagent is busy with native/user interaction.",
        );
        return;
      }
      turn.dispatched = true;
      turn.activity = "Thinking…";
      changed();
      e.worker.session.send(turn.command);
    } catch (error) {
      if (e.turn !== turn) return;
      const msg = error instanceof Error ? error.message : String(error);
      const outcome = turn.canceling ? "stopped" : "error";
      await destroyWorker(e, () => settleTurn(e, outcome, msg));
    }
  };

  /**
   * Game-loop style Reconcile System:
   * 1. Reaper System: releases idle headless workers without open views.
   * 2. Scheduler System: assigns concurrency slots to queued TurnComponents and launches them.
   */
  function reconcile(): void {
    if (disposed) return;

    // System 1: Reaper (release finished headless workers)
    if (!supportsView) {
      for (const e of entities.values()) {
        if (
          !e.turn &&
          e.worker &&
          !e.worker.closing &&
          !e.worker.cleanupError &&
          e.worker.interactiveActivity === undefined
        ) {
          void destroyWorker(e);
        }
      }
    }

    // System 2: Scheduler (dispatch queued turns within maxConcurrent budget)
    const max = options.maxConcurrent ?? 4;
    for (const e of entities.values()) {
      if (activeSlotCount() >= max) break;
      const turn = e.turn;
      if (
        !turn ||
        turn.dispatched ||
        turn.launching ||
        turn.startedAt !== undefined
      ) {
        continue;
      }
      turn.startedAt = Date.now();
      changed();
      const launch = executeTurn(e, turn).finally(() => {
        if (turn.launching === launch) turn.launching = undefined;
      });
      turn.launching = launch;
    }
  }

  const liveView = async (
    e: SubagentEntity,
  ): Promise<ViewHandle | undefined> => {
    const view = e.worker?.view;
    if (
      view &&
      executor.inspect_view &&
      !(await executor.inspect_view(view)).alive
    ) {
      await executor.close_view?.(view);
      if (e.worker?.view === view) {
        e.worker.view = undefined;
        changed();
      }
    }
    return e.worker?.view;
  };

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    list: () => [...entities.values()].map(snap),
    get: (id) => snap(getEntity(id)),
    spawn(spawnOpts) {
      if (disposed) throw new Error("Subagent manager is closed.");
      const command = createTaskCommand(spawnOpts.prompt);
      const parentSession = prepareParentSnapshot(spawnOpts);
      const firstLine = spawnOpts.prompt
        .trim()
        .split(/\r?\n/)[0]
        ?.replace(/\s+/g, " ")
        .trim();
      const description =
        spawnOpts.description?.trim() ||
        (firstLine
          ? firstLine.slice(0, 80)
          : (spawnOpts.agent?.displayName ??
            spawnOpts.agent?.name ??
            "Subagent task"));
      const id = `sub-${nextSequence++}`;
      const sessionKey = randomUUID();
      const entity: SubagentEntity = {
        id,
        sessionKey,
        description,
        options: {
          ...spawnOpts,
          description,
          parentSession,
          context: undefined,
          sessionName: `Sub · ${spawnOpts.agent?.name ?? "-"} · ${description.replace(/\s+/g, " ").trim()}`,
        },
        turn: createTurnComponent(1, command),
        lastInteractionSeq: 0,
      };
      entities.set(id, entity);
      changed();
      reconcile();
      return snap(entity);
    },
    backgroundPreference: (id) => getEntity(id).options.agent?.runInBackground,
    async send(id, sendOpts) {
      if (disposed) throw new Error("Subagent manager is closed.");
      const e = getEntity(id);
      if (!sendOpts.prompt.trim())
        throw new Error("Task prompt must not be blank.");
      if (e.worker?.closing) await e.worker.closing.catch(() => undefined);
      if (e.turn) {
        if (
          e.turn.dispatched &&
          !e.turn.canceling &&
          e.worker?.session.connected &&
          !e.worker.closing &&
          !e.worker.cleanupError
        ) {
          e.worker.session.send({
            type: "steer",
            message: sendOpts.prompt,
            ...(e.turn.round > 1 ? { round: e.turn.round } : {}),
          });
          return {
            ...snap(e),
            hint: `Steering message delivered to active round. Call subagent_ctl({ id: "${id}", action: "wait" }) to wait for the final result.`,
          };
        }
        if (!e.turn.dispatched && !e.turn.launching) {
          const combined = `${e.options.prompt}\n\n${sendOpts.prompt}`;
          e.turn.command = createTaskCommand(combined, e.turn.round);
          e.options = { ...e.options, prompt: combined };
          if (sendOpts.description) e.description = sendOpts.description;
          changed();
          return snap(e);
        }
        throw new Error(
          `Subagent ${id} is currently ${deriveStatus(e)}; wait for it to settle or steer while running.`,
        );
      }
      if (e.worker?.closing) {
        throw new Error(
          "Worker cleanup is still in progress; resume is unavailable.",
        );
      }
      if (e.worker?.interactiveActivity !== undefined) {
        throw new Error(
          "Resume requires an idle session; wait for native/user interaction to settle.",
        );
      }
      const round = (e.settled?.round ?? 1) + 1;
      const command = createTaskCommand(sendOpts.prompt, round);
      if (sendOpts.description) {
        e.description = sendOpts.description;
        e.options = { ...e.options, description: sendOpts.description };
      }
      e.options = { ...e.options, prompt: sendOpts.prompt };
      e.turn = createTurnComponent(round, command);
      changed();
      reconcile();
      return snap(e);
    },
    async result(id, wait = false, signal) {
      const e = getEntity(id);
      const turn = e.turn;
      if (wait && turn) {
        turn.waiters += 1;
        try {
          const resolved = await (signal
            ? new Promise<AgentSnapshot>((resolve, reject) => {
                signal.throwIfAborted();
                const onAbort = () =>
                  reject(signal.reason ?? new Error("Wait canceled."));
                signal.addEventListener("abort", onAbort, { once: true });
                turn.completion.then(resolve, reject).finally(() => {
                  signal.removeEventListener("abort", onAbort);
                });
              })
            : turn.completion);
          if (e.settled?.round === turn.round) e.settled.consumed = true;
          return { ...resolved };
        } finally {
          turn.waiters -= 1;
          if (
            !e.turn &&
            e.settled?.round === turn.round &&
            !e.settled.consumed &&
            turn.waiters === 0 &&
            !e.settled.notified &&
            !disposed
          ) {
            e.settled.notified = true;
            try {
              options.onComplete?.(snap(e));
            } catch {}
          }
        }
      }
      if (!turn && e.settled) e.settled.consumed = true;
      return snap(e);
    },
    stop(id) {
      const e = getEntity(id);
      if (!e.turn) {
        if (e.worker?.cleanupError) void destroyWorker(e);
        return snap(e);
      }
      const turn = e.turn;
      if (!turn.dispatched && turn.startedAt === undefined) {
        settleTurn(e, "stopped");
        return snap(e);
      }
      if (e.worker?.cleanupError) {
        turn.canceling = true;
        void destroyWorker(e, () => settleTurn(e, "stopped"));
        return snap(e);
      }
      if (!turn.canceling) {
        turn.canceling = true;
        if (!turn.dispatched || !e.worker?.session.connected) {
          void destroyWorker(e, () => settleTurn(e, "stopped"));
        } else {
          try {
            e.worker.session.send({
              type: "cancel",
              ...(turn.round > 1 ? { round: turn.round } : {}),
            });
          } catch {
            void destroyWorker(e, () => settleTurn(e, "stopped"));
          }
          turn.cancelTimer = setTimeout(() => {
            if (e.turn === turn) {
              void destroyWorker(e, () => settleTurn(e, "stopped"));
            }
          }, options.cancelTimeoutMs ?? 5_000);
        }
      }
      changed();
      return snap(e);
    },
    openView(id) {
      const e = getEntity(id);
      return serializeView(async () => {
        if (disposed) throw new Error("Subagent manager is closed.");
        if (!supportsView || !executor.open_view) {
          throw new Error(
            "Current executor does not support interactive terminal views.",
          );
        }
        if (!e.worker || e.worker.closing || e.worker.cleanupError) {
          throw new Error("Subagent runtime is closed/released.");
        }
        const terminal = e.worker.session.terminal;
        if (!terminal) throw new Error("Subagent terminal is not ready yet.");
        const existing = await liveView(e);
        if (existing) {
          await executor.focus_view?.(existing);
          return existing;
        }
        const view = await executor.open_view({ terminal });
        e.worker.view = view;
        changed();
        return view;
      });
    },
    closeView(id) {
      const e = getEntity(id);
      return serializeView(async () => {
        if (e.worker?.view && executor.close_view) {
          await executor.close_view(e.worker.view);
          e.worker.view = undefined;
          changed();
        }
      });
    },
    async remove(id) {
      const e = getEntity(id);
      const launch = e.turn?.launching;
      if (e.turn) {
        clearTimeout(e.turn.cancelTimer);
        e.turn.canceling = true;
      }
      void e.worker?.session.close().catch(() => undefined);
      await launch?.catch(() => undefined);
      await destroyWorker(e);
      if (e.worker?.cleanupError) {
        throw new Error(
          `Could not delete subagent ${id} (${e.worker.cleanupError}); retry deletion.`,
        );
      }
      if (e.turn) settleTurn(e, "stopped");
      entities.delete(id);
      changed();
      reconcile();
    },
    close() {
      closing ??= (async () => {
        disposed = true;
        const launches: Promise<void>[] = [];
        for (const e of entities.values()) {
          if (e.turn?.launching) launches.push(e.turn.launching);
          if (e.turn) settleTurn(e, "stopped");
        }
        await Promise.allSettled(launches);
        await Promise.allSettled(
          [...entities.values()].map((e) => destroyWorker(e)),
        );
        const errors = [...entities.values()].flatMap((e) =>
          e.worker?.cleanupError
            ? [
                new Error(
                  `Could not clean up subagent ${e.id}: ${e.worker.cleanupError}`,
                ),
              ]
            : [],
        );
        if (errors.length) {
          throw new AggregateError(
            errors,
            "Some subagent terminals could not be cleaned up.",
          );
        }
      })().catch((err) => {
        closing = undefined;
        throw err;
      });
      return closing;
    },
  };
}
