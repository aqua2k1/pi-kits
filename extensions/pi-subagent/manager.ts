import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ExtensionContext,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import {
  captureParentSession,
  createClonedSession,
  type ParentSessionSnapshot,
} from "./clone.ts";
import {
  type AgentDefinition,
  resolveWorkerExtensions,
  SUBAGENT_DEFAULT_EXTENSIONS,
  type WorkerExtensionSource,
} from "./config.ts";
import {
  type Executor,
  type InspectResult,
  MAX_COMMAND_BYTES,
  type ReadResult,
  type TerminalHandle,
  type ViewHandle,
  WORKER_MARKER,
} from "./execute/index.ts";
import { createSerializer } from "./util.ts";

export type WorkerSessionState = "idle" | "running" | "interactive";

export function isBackendSessionState(v: unknown): v is WorkerSessionState {
  return v === "idle" || v === "running" || v === "interactive";
}

export interface SessionUpdate {
  type: "session_update";
  interactionId: string;
  sequence: number;
  response: string;
  outcome: "completed" | "aborted" | "error";
  truncated?: boolean;
  error?: string;
}

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

/** Component 1: Live Executor Handle Attachment (exists only while a terminal/process is allocated). */
interface WorkerComponent {
  terminal?: TerminalHandle;
  promptDirectory?: string;
  view?: ViewHandle;
  interactiveActivity?: string;
  cleanupError?: string;
  closing?: Promise<void>;
}

/** Component 2: Active Managed Turn (exists only while a round is queued, starting, or running). */
interface TurnComponent {
  readonly round: number;
  prompt: string;
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
// Pure Derived State Queries
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
    if (e.worker.terminal) return "idle";
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
    terminalId: sessionState === "closed" ? undefined : e.worker?.terminal?.id,
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
// Worker Argv Builder & Coordinator Helpers
// ============================================================================

function validatePrompt(prompt: string): string {
  if (!prompt.trim()) throw new Error("Task prompt must not be blank.");
  if (Buffer.byteLength(prompt, "utf8") > MAX_COMMAND_BYTES) {
    throw new Error("Subagent command exceeds the 64 KiB protocol limit.");
  }
  return prompt;
}

async function prepareWorkerLaunch(
  entity: SubagentEntity,
  supportsView: boolean,
  managerOptions: ManagerOptions,
): Promise<{ argv: string[]; promptDirectory?: string }> {
  const extensions = await resolveWorkerExtensions(
    entity.options.agent?.extensions ??
      managerOptions.extensionAllowlist ??
      SUBAGENT_DEFAULT_EXTENSIONS,
  );
  if (!entity.sessionPath) {
    if (entity.options.parentSession) {
      entity.sessionPath = createClonedSession(
        entity.options.parentSession,
        entity.options.cwd,
        `subagent-${entity.sessionKey}`,
      );
    } else {
      entity.sessionPath = SessionManager.create(
        entity.options.cwd,
        undefined,
        { id: `subagent-${entity.sessionKey}` },
      ).getSessionFile();
    }
  }
  const argv = [
    managerOptions.executable ?? "pi",
    ...(supportsView ? [] : ["--mode", "rpc"]),
    "--no-extensions",
    ...extensions.flatMap((ext) => ["-e", ext]),
    ...(entity.sessionPath
      ? ["--session", entity.sessionPath]
      : ["--session-id", `subagent-${entity.sessionKey}`]),
  ];
  if (entity.options.sessionName)
    argv.push("--name", entity.options.sessionName);
  const model = entity.options.agent?.model ?? entity.options.model;
  const thinking = entity.options.agent?.thinking ?? entity.options.thinking;
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
  let promptDirectory: string | undefined;
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
  return { argv, promptDirectory };
}

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
  prompt: string,
  now = Date.now(),
): TurnComponent {
  validatePrompt(prompt);
  let resolve: (snap: AgentSnapshot) => void = () => undefined;
  const completion = new Promise<AgentSnapshot>((done) => {
    resolve = done;
  });
  return {
    round,
    prompt,
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

  const destroyWorker = (
    e: SubagentEntity,
    onCleaned?: () => void,
  ): Promise<void> => {
    const worker = e.worker;
    if (!worker) {
      onCleaned?.();
      return Promise.resolve();
    }
    if (worker.closing) {
      return onCleaned
        ? worker.closing.then(() => {
            if (!worker.cleanupError && e.worker !== worker) onCleaned();
          })
        : worker.closing;
    }
    worker.cleanupError = undefined;
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
      let termErr: unknown;
      if (worker.terminal) {
        try {
          await executor.destroy(worker.terminal);
          worker.terminal = undefined;
        } catch (err) {
          termErr = err;
        }
      }
      if (!termErr && worker.promptDirectory) {
        rmSync(worker.promptDirectory, { recursive: true, force: true });
        worker.promptDirectory = undefined;
      }
      const cause = termErr ?? viewErr;
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

  const applyReadResult = (
    e: SubagentEntity,
    turn: TurnComponent | undefined,
    readRes: ReadResult,
  ): void => {
    if (readRes.sessionPath) e.sessionPath = readRes.sessionPath;
    if (validText(readRes.model)) e.model = readRes.model;
    if (readRes.stats && turn) {
      turn.stats = { ...turn.stats, ...readRes.stats };
    }
    applyReply(e, readRes.text, readRes.truncated === true);
  };

  const syncInspectState = (e: SubagentEntity, status: InspectResult): void => {
    if (!e.worker) return;
    if (status.state === "blocked") {
      e.worker.interactiveActivity =
        status.message ||
        (status.blockedKind
          ? `Waiting for ${status.blockedKind}`
          : "User interaction");
    } else if (!e.turn && status.state === "working") {
      e.worker.interactiveActivity = status.message || "Thinking…";
    } else {
      e.worker.interactiveActivity = undefined;
    }
  };

  const executeTurn = async (
    e: SubagentEntity,
    turn: TurnComponent,
  ): Promise<void> => {
    try {
      let inspected =
        e.worker?.terminal && !e.worker.cleanupError
          ? await executor.inspect(e.worker.terminal)
          : { alive: false };
      syncInspectState(e, inspected);

      if (e.turn !== turn || disposed || turn.canceling) {
        await destroyWorker(e, () => settleTurn(e, "stopped"));
        return;
      }
      if (!inspected.alive) {
        if (e.worker) await destroyWorker(e);
        const worker: WorkerComponent = {};
        e.worker = worker;
        const { argv, promptDirectory } = await prepareWorkerLaunch(
          e,
          executor.supportsView,
          options,
        );
        worker.promptDirectory = promptDirectory;
        if (e.turn !== turn || disposed || turn.canceling) {
          await destroyWorker(e, () => settleTurn(e, "stopped"));
          return;
        }
        worker.terminal = await executor.start({
          agentId: e.id,
          agentType: e.options.agent?.name,
          cwd: e.options.cwd,
          sessionPath: e.sessionPath,
          argv,
          env: { [WORKER_MARKER]: "1" },
        });
        inspected = await executor.inspect(worker.terminal);
        syncInspectState(e, inspected);
      }
      const terminal = e.worker?.terminal;
      if (e.turn !== turn || disposed || turn.canceling) {
        await destroyWorker(e, () => settleTurn(e, "stopped"));
        return;
      }
      if (!terminal || !inspected.alive) {
        throw new Error("Subagent runtime disconnected during startup.");
      }
      if (
        e.worker?.interactiveActivity !== undefined ||
        inspected.state === "blocked" ||
        inspected.state === "working"
      ) {
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

      await executor.send(terminal, turn.prompt, { if: "idle" });
      if (e.turn !== turn || disposed) return;

      const settledStatus = await executor.wait(terminal);
      if (e.turn !== turn || e.worker?.terminal !== terminal) return;
      syncInspectState(e, settledStatus);

      if (!settledStatus.alive) {
        const outcome = turn.canceling ? "stopped" : "error";
        await destroyWorker(e, () =>
          settleTurn(e, outcome, "Pi worker disconnected."),
        );
        return;
      }

      const readRes = await executor.read(terminal);
      if (e.turn !== turn || e.worker?.terminal !== terminal) return;
      applyReadResult(e, turn, readRes);

      if (turn.canceling || readRes.aborted) {
        settleTurn(e, "stopped");
      } else if (settledStatus.state === "error" || readRes.error) {
        settleTurn(
          e,
          "error",
          readRes.error ?? settledStatus.message ?? "Pi assistant failed",
        );
      } else if (settledStatus.state === "blocked") {
        settleTurn(
          e,
          "error",
          settledStatus.message ??
            "Subagent is blocked waiting for user input.",
        );
      } else {
        settleTurn(e, "completed");
      }
    } catch (error) {
      if (e.turn !== turn) return;
      const msg = error instanceof Error ? error.message : String(error);
      const outcome = turn.canceling ? "stopped" : "error";
      await destroyWorker(e, () => settleTurn(e, outcome, msg));
    }
  };

  function reconcile(): void {
    if (disposed) return;
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

  const refreshLiveWorker = async (e: SubagentEntity): Promise<void> => {
    const terminal = e.worker?.terminal;
    if (!e.worker || e.worker.closing || e.worker.cleanupError || !terminal) {
      return;
    }
    try {
      const status = await executor.inspect(terminal);
      const prevInteractive = e.worker.interactiveActivity;
      syncInspectState(e, status);
      if (e.worker.interactiveActivity !== prevInteractive) changed();
      if (!e.turn && status.alive && status.state !== "working") {
        const readRes = await executor.read(terminal);
        if (readRes.sessionPath) e.sessionPath = readRes.sessionPath;
        if (validText(readRes.model)) e.model = readRes.model;
        if (readRes.text && readRes.text !== e.reply?.text) {
          const seq = ++e.lastInteractionSeq;
          applyReply(e, readRes.text, readRes.truncated === true, seq);
          changed();
          try {
            options.onSessionUpdate?.(snap(e), {
              type: "session_update",
              interactionId: randomUUID(),
              sequence: seq,
              response: readRes.text,
              outcome: readRes.error
                ? "error"
                : readRes.aborted
                  ? "aborted"
                  : "completed",
              ...(readRes.truncated ? { truncated: true } : {}),
              ...(readRes.error ? { error: readRes.error } : {}),
            });
          } catch {}
        }
      }
    } catch {}
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
      const prompt = validatePrompt(spawnOpts.prompt);
      const parentSession = prepareParentSnapshot(spawnOpts);
      const firstLine = prompt
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
      const entity: SubagentEntity = {
        id,
        sessionKey: randomUUID(),
        description,
        options: {
          ...spawnOpts,
          description,
          parentSession,
          context: undefined,
          sessionName: `Sub · ${spawnOpts.agent?.name ?? "-"} · ${description.replace(/\s+/g, " ").trim()}`,
        },
        turn: createTurnComponent(1, prompt),
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
      const prompt = validatePrompt(sendOpts.prompt);
      if (e.worker?.closing) await e.worker.closing.catch(() => undefined);
      await refreshLiveWorker(e);

      if (e.turn) {
        if (
          e.turn.dispatched &&
          !e.turn.canceling &&
          e.worker?.terminal &&
          !e.worker.closing &&
          !e.worker.cleanupError
        ) {
          await executor.send(e.worker.terminal, prompt, { if: "working" });
          return {
            ...snap(e),
            hint: `Steering message delivered to active round. Call subagent_ctl({ id: "${id}", action: "wait" }) to wait for the final result.`,
          };
        }
        if (!e.turn.dispatched && !e.turn.launching) {
          const combined = validatePrompt(`${e.options.prompt}\n\n${prompt}`);
          e.turn.prompt = combined;
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
      const turn = createTurnComponent(round, prompt);
      if (sendOpts.description) {
        e.description = sendOpts.description;
        e.options = { ...e.options, description: sendOpts.description };
      }
      e.options = { ...e.options, prompt };
      e.turn = turn;
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
      await refreshLiveWorker(e);
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
        const terminal = e.worker?.terminal;
        if (!turn.dispatched || !terminal) {
          void destroyWorker(e, () => settleTurn(e, "stopped"));
        } else {
          void executor.interrupt(terminal).catch(() => {
            void destroyWorker(e, () => settleTurn(e, "stopped"));
          });
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
        const terminal = e.worker.terminal;
        if (!terminal) throw new Error("Subagent terminal is not ready yet.");
        const view = e.worker.view;
        if (
          view &&
          executor.inspect_view &&
          !(await executor.inspect_view(view)).alive
        ) {
          await executor.close_view?.(view);
          e.worker.view = undefined;
          changed();
        }
        if (e.worker.view) {
          await executor.focus_view?.(e.worker.view);
          return e.worker.view;
        }
        e.worker.view = await executor.open_view({ terminal });
        changed();
        return e.worker.view;
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
      await destroyWorker(e);
      await launch?.catch(() => undefined);
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
        for (const e of entities.values()) {
          if (e.turn) settleTurn(e, "stopped");
        }
        await Promise.allSettled(
          [...entities.values()].map((e) => destroyWorker(e)),
        );
        const launches: Promise<void>[] = [];
        for (const e of entities.values()) {
          if (e.turn?.launching) launches.push(e.turn.launching);
        }
        await Promise.allSettled(launches);
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
