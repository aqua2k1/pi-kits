import { randomUUID } from "node:crypto";
import type { AgentDefinition } from "./agents.ts";
import type { MuxAdapter, ViewHandle } from "./mux/index.ts";
import {
  canAutoRelease,
  dispatchBlocker,
  nativeViewBlocker,
  resumeBlocker,
  steerBlocker,
} from "./policy.ts";
import { createCodexRuntime } from "./runtime/codex/index.ts";
import {
  type AgentRuntime,
  MAX_COMMAND_BYTES,
  MAX_RESULT_BYTES,
  type RuntimeCapabilities,
  type RuntimeCommand,
  type RuntimeEvent,
  type RuntimeEventMeta,
  type RuntimeId,
  type RuntimeOptions,
  type RuntimeSession,
  RuntimeTaskRejectedError,
  type SessionUpdate,
} from "./runtime/index.ts";
import { createPiRuntime } from "./runtime/pi/index.ts";
import {
  type AgentStatus,
  isBackendSessionState,
  type SessionState,
} from "./state.ts";
import { createSerializer } from "./util.ts";

export type { AgentStatus, SessionState } from "./state.ts";
export { isTerminalStatus } from "./state.ts";

export interface AgentSnapshot {
  id: string;
  description: string;
  /** Absolute working directory fixed at spawn and retained across rounds. */
  cwd?: string;
  status: AgentStatus;
  round?: number;
  inheritedContext?: boolean;
  keepAlive?: boolean;
  runtime?: RuntimeId;
  runtimeName?: string;
  capabilities?: RuntimeCapabilities;
  runtimeSessionId?: string;
  sessionState?: SessionState;
  sessionActivity?: string;
  subagentType?: string;
  displayName?: string;
  model?: string;
  configuredModel?: string;
  modelName?: string;
  agentSource?: AgentDefinition["source"];
  agentPath?: string;
  /** Latest settled reply, including native/user interactions. */
  result?: string;
  resultSource?: "managed" | "user_interaction";
  resultRevision?: number;
  resultUpdatedAt?: number;
  resultOutcome?: SessionUpdate["outcome"];
  resultError?: string;
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
}

export interface SpawnOptions {
  keepAlive?: boolean;
  runtime?: RuntimeId;
  prompt: string;
  description: string;
  cwd: string;
  /** Name chosen at spawn and retained across rounds. */
  sessionName?: string;
  model?: string;
  thinking?: string;
  agent?: AgentDefinition;
  runtimeConfig?: Record<string, unknown>;
  runtimeParams?: Record<string, unknown>;
  context?: unknown;
  parentSession?: unknown;
}

export interface ResumeOptions {
  prompt: string;
  runtimeParams?: Record<string, unknown>;
  description?: string;
}

export interface ManagerOptions {
  runtimes?: readonly AgentRuntime[];
  maxConcurrent?: number;
  startupTimeoutMs?: number;
  cancelTimeoutMs?: number;
  runtimeExecutables?: Partial<Record<RuntimeId, string>>;
  onComplete?: (snapshot: AgentSnapshot) => void;
  onSessionUpdate?: (snapshot: AgentSnapshot, update: SessionUpdate) => void;
}

export interface SubagentManager {
  subscribe(listener: () => void): () => void;
  list(): AgentSnapshot[];
  get(id: string): AgentSnapshot;
  runtimeCapabilities(id: RuntimeId): RuntimeCapabilities;
  spawn(options: SpawnOptions): AgentSnapshot;
  backgroundPreference(id: string): boolean | undefined;
  resume(id: string, options: ResumeOptions): AgentSnapshot;
  result(
    id: string,
    wait?: boolean,
    signal?: AbortSignal,
  ): Promise<AgentSnapshot>;
  steer(id: string, message: string): void | Promise<void>;
  stop(id: string): AgentSnapshot;
  openView(id: string): Promise<ViewHandle>;
  closeView(id: string): Promise<void>;
  release(id: string): Promise<void>;
  remove(id: string): Promise<void>;
  close(): Promise<void>;
}

interface Execution {
  round: number;
  command: RuntimeCommand;
  reused: boolean;
  dispatched: boolean;
  accepted: boolean;
  consumed: boolean;
  waiters: number;
  notified: boolean;
  finished: boolean;
  resolve: (snapshot: AgentSnapshot) => void;
  completion: Promise<AgentSnapshot>;
  snapshot?: AgentSnapshot;
}

interface AgentRecord {
  snapshot: AgentSnapshot;
  options: SpawnOptions;
  runtime: AgentRuntime;
  session?: RuntimeSession;
  view?: ViewHandle;
  execution: Execution;
  cancelTimer?: ReturnType<typeof setTimeout>;
  terminating?: Promise<void>;
  launch?: Promise<void>;
  releaseRequested?: boolean;
  releasing?: Promise<void>;
  openingViews?: number;
  lastInteractionSequence?: number;
  lastResultSequence?: number;
  viewTimer?: ReturnType<typeof setTimeout>;
}

// --- Pure functional core: snapshot construction, event reduction & validation ---

function validMetadataText(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= 4096 &&
    !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(value)
  );
}

/** Ignore malformed optional metadata without replacing the last known model. */
function applyModelMetadata(
  snapshot: AgentSnapshot,
  event: RuntimeEventMeta,
): AgentSnapshot {
  const next = { ...snapshot };
  if (typeof event.runtimeSessionId === "string") {
    next.runtimeSessionId = event.runtimeSessionId;
  }
  if (typeof event.sessionPath === "string") {
    next.sessionPath = event.sessionPath;
  }
  if (validMetadataText(event.model)) {
    if (event.model !== next.model) next.modelName = undefined;
    next.model = event.model;
  }
  if (
    validMetadataText(event.modelName) &&
    (event.model === undefined || validMetadataText(event.model))
  ) {
    next.modelName = event.modelName;
  }
  return next;
}

function applyStatsEvent(
  snapshot: AgentSnapshot,
  event: Extract<RuntimeEvent, { type: "stats" }>,
): AgentSnapshot {
  const next = applyModelMetadata(snapshot, event);
  for (const key of [
    "turnCount",
    "toolUses",
    "totalTokens",
    "compactionCount",
  ] as const) {
    const value = event[key];
    if (
      typeof value === "number" &&
      Number.isSafeInteger(value) &&
      value >= 0
    ) {
      next[key] = value;
    }
  }
  next.contextPercent =
    typeof event.contextPercent === "number" &&
    Number.isFinite(event.contextPercent) &&
    event.contextPercent >= 0 &&
    event.contextPercent <= 100
      ? event.contextPercent
      : undefined;
  return next;
}

function applyResultUpdate(
  snapshot: AgentSnapshot,
  lastResultSequence: number | undefined,
  update: {
    response: string;
    source: AgentSnapshot["resultSource"];
    outcome: SessionUpdate["outcome"];
    truncated: boolean;
    error?: string;
    sequence?: number;
  },
  now = Date.now(),
): { snapshot: AgentSnapshot; lastResultSequence: number | undefined } {
  let nextSequence = lastResultSequence;
  if (update.sequence !== undefined) {
    if (!Number.isSafeInteger(update.sequence) || update.sequence < 1) {
      throw new Error("Invalid result sequence");
    }
    if (update.sequence <= (lastResultSequence ?? 0)) {
      return { snapshot, lastResultSequence };
    }
    nextSequence = update.sequence;
  }
  if (!update.response) {
    return { snapshot, lastResultSequence: nextSequence };
  }
  return {
    lastResultSequence: nextSequence,
    snapshot: {
      ...snapshot,
      result: update.response,
      resultSource: update.source,
      resultRevision: (snapshot.resultRevision ?? 0) + 1,
      resultUpdatedAt: now,
      resultOutcome: update.outcome,
      resultError: update.error,
      truncated: update.truncated,
    },
  };
}

function parseSessionUpdateEvent(
  event: Extract<RuntimeEvent, { type: "session_update" }>,
): SessionUpdate {
  const raw = event as unknown as Record<string, unknown>;
  if (
    typeof raw.interactionId !== "string" ||
    !raw.interactionId.trim() ||
    raw.interactionId.length > 4096 ||
    typeof raw.sequence !== "number" ||
    !Number.isSafeInteger(raw.sequence) ||
    raw.sequence < 1 ||
    typeof raw.response !== "string" ||
    Buffer.byteLength(raw.response) > MAX_RESULT_BYTES ||
    !["completed", "aborted", "error"].includes(String(raw.outcome)) ||
    (raw.error !== undefined && typeof raw.error !== "string")
  ) {
    throw new Error("Invalid session update");
  }
  return {
    type: "session_update",
    interactionId: raw.interactionId,
    sequence: raw.sequence,
    response: raw.response,
    outcome: raw.outcome as SessionUpdate["outcome"],
    truncated: raw.truncated === true,
    error: typeof raw.error === "string" ? raw.error : undefined,
  };
}

function createInitialSnapshot(
  id: string,
  runtime: AgentRuntime,
  options: SpawnOptions,
  now = Date.now(),
): AgentSnapshot {
  return {
    id,
    runtime: runtime.id,
    runtimeName: runtime.displayName,
    capabilities: { ...runtime.capabilities },
    description: options.description,
    cwd: options.cwd,
    status: "queued",
    round: 1,
    inheritedContext: Boolean(options.parentSession),
    keepAlive: options.agent?.keepAlive ?? options.keepAlive ?? false,
    model: options.agent?.model ?? options.model,
    configuredModel: options.agent?.model,
    ...(options.agent
      ? {
          subagentType: options.agent.name,
          displayName: options.agent.displayName,
          agentSource: options.agent.source,
          agentPath: options.agent.sourcePath,
        }
      : {}),
    createdAt: now,
    turnCount: 0,
    toolUses: 0,
    totalTokens: 0,
    compactionCount: 0,
  };
}

function createResumedSnapshot(
  previous: AgentSnapshot,
  description: string,
  round: number,
  now = Date.now(),
): AgentSnapshot {
  return {
    ...previous,
    description,
    round,
    status: "queued",
    error: undefined,
    activity: undefined,
    sessionActivity: undefined,
    createdAt: now,
    startedAt: undefined,
    completedAt: undefined,
    turnCount: 0,
    toolUses: 0,
    totalTokens: 0,
    contextPercent: undefined,
    compactionCount: 0,
  };
}

function projectSnapshot(
  record: AgentRecord,
  sessionClosed: boolean,
): AgentSnapshot {
  return {
    ...record.snapshot,
    capabilities: {
      ...(record.session?.capabilities ??
        record.snapshot.capabilities ??
        record.runtime.capabilities),
    },
    terminalId:
      record.snapshot.sessionState === "closed" || sessionClosed
        ? undefined
        : record.session?.terminal?.id,
    viewId: record.view?.id,
  };
}

function buildRuntimeOptions(
  id: string,
  options: SpawnOptions,
  runtimeId: RuntimeId,
  managerOptions: ManagerOptions,
): RuntimeOptions {
  return {
    id,
    cwd: options.cwd,
    sessionName: options.sessionName,
    model: options.agent?.model ?? options.model,
    thinking: options.agent?.thinking ?? options.thinking,
    agent: options.agent,
    runtimeConfig: options.runtimeConfig,
    context: options.context,
    parentSession: options.parentSession,
    executable: managerOptions.runtimeExecutables?.[runtimeId],
    startupTimeoutMs: managerOptions.startupTimeoutMs,
  };
}

function parseRuntimeTask(
  runtime: AgentRuntime,
  command: RuntimeCommand,
  options: RuntimeOptions,
): RuntimeCommand {
  if (runtime.parseTask) return runtime.parseTask(command, options);
  if (command.type === "task" && !command.prompt.trim()) {
    throw new Error("Task prompt must not be blank.");
  }
  return command;
}

function createExecution(
  round: number,
  command: RuntimeCommand,
  reused = false,
): Execution {
  let resolve: Execution["resolve"] = () => undefined;
  const completion = new Promise<AgentSnapshot>((done) => {
    resolve = done;
  });
  return {
    round,
    command,
    reused,
    dispatched: false,
    accepted: false,
    consumed: false,
    waiters: 0,
    notified: false,
    finished: false,
    completion,
    resolve,
  };
}

function taskCommand(options: SpawnOptions): RuntimeCommand {
  return {
    type: "task" as const,
    prompt: options.prompt,
    ...(Object.keys(options.runtimeParams ?? {}).length
      ? { runtimeParams: options.runtimeParams }
      : {}),
  };
}

function validateCommand(command: object): void {
  if (Buffer.byteLength(JSON.stringify(command)) > MAX_COMMAND_BYTES) {
    throw new Error("Subagent command exceeds the 64 KiB protocol limit.");
  }
}

async function waitFor<T>(
  promise: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  signal?.throwIfAborted();
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error("Wait canceled."));
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", abort);
    });
  });
}

// --- Imperative shell: queueing, lifecycle coordination & resource ownership ---

/** Owns managed rounds, queueing and resource release; runtimes own execution resources. */
export function createSubagentManager(
  adapter: MuxAdapter,
  options: ManagerOptions = {},
): SubagentManager {
  const records = new Map<string, AgentRecord>();
  const listeners = new Set<() => void>();
  const viewOperation = createSerializer();
  const queue: { record: AgentRecord; execution: Execution }[] = [];
  const runtimes = new Map<RuntimeId, AgentRuntime>();
  const launches = new Set<Promise<void>>();
  const closedSessions = new WeakSet<RuntimeSession>();
  let active = 0;
  let disposed = false;
  let closing: Promise<void> | undefined;

  for (const runtime of [
    createPiRuntime(),
    createCodexRuntime(),
    ...(options.runtimes ?? []),
  ]) {
    runtimes.set(runtime.id, runtime);
  }

  const changed = (): void => {
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        // A view/render failure must never alter task execution.
      }
    }
  };

  const getRecord = (id: string): AgentRecord => {
    const found = records.get(id);
    if (!found) throw new Error(`Unknown subagent: ${id}`);
    return found;
  };

  const getRuntime = (id: RuntimeId): AgentRuntime => {
    const found = runtimes.get(id);
    if (!found) throw new Error(`Unknown subagent runtime: ${id}`);
    return found;
  };

  const snapshot = (record: AgentRecord): AgentSnapshot =>
    projectSnapshot(
      record,
      Boolean(record.session && closedSessions.has(record.session)),
    );

  const clearViewTimer = (record: AgentRecord): void => {
    clearTimeout(record.viewTimer);
    record.viewTimer = undefined;
  };

  const forgetView = (record: AgentRecord): void => {
    clearViewTimer(record);
    record.view = undefined;
    changed();
  };

  const checkNativeView = (record: AgentRecord): void => {
    if (disposed) throw new Error("Subagent manager is closed.");
    const blocker = nativeViewBlocker(
      record,
      Boolean(record.session && closedSessions.has(record.session)),
    );
    if (blocker) throw new Error(blocker);
  };

  const notify = (record: AgentRecord, execution = record.execution): void => {
    if (
      disposed ||
      execution.consumed ||
      execution.waiters > 0 ||
      execution.notified
    ) {
      return;
    }
    execution.notified = true;
    try {
      options.onComplete?.({ ...(execution.snapshot ?? snapshot(record)) });
    } catch {
      // A parent notification failure cannot invalidate a completed task.
    }
  };

  const closeSession = async (
    record: AgentRecord,
  ): Promise<unknown | undefined> => {
    try {
      const session = record.session;
      if (session && !closedSessions.has(session)) {
        await session.close();
        closedSessions.add(session);
      }
      record.snapshot = {
        ...record.snapshot,
        sessionState: "closed",
        sessionActivity: undefined,
      };
      return undefined;
    } catch (error) {
      // Retain ownership and the concurrency slot until cleanup can be retried.
      const detail = error instanceof Error ? error.message : String(error);
      record.snapshot = {
        ...record.snapshot,
        sessionState: "disconnected",
        sessionActivity: `Worker cleanup failed (${detail}); retry stop_subagent.`,
      };
      changed();
      return error;
    }
  };

  const scheduleViewCheck = (record: AgentRecord): void => {
    if (
      disposed ||
      record.releaseRequested ||
      record.snapshot.keepAlive ||
      !record.execution.finished ||
      !record.view ||
      record.viewTimer
    ) {
      return;
    }
    record.viewTimer = setTimeout(() => {
      record.viewTimer = undefined;
      autoRelease(record);
    }, 1_000);
    record.viewTimer.unref();
  };

  const liveView = async (
    record: AgentRecord,
  ): Promise<ViewHandle | undefined> => {
    if (record.view && !(await adapter.inspect_view(record.view)).alive) {
      await adapter.close_view(record.view);
      forgetView(record);
      autoRelease(record);
    }
    return record.view;
  };

  const release = (id: string): Promise<void> => {
    const record = getRecord(id);
    if (record.releasing) return record.releasing;
    if (!record.execution.finished) {
      return Promise.reject(
        new Error("Only a finished managed task can be released."),
      );
    }
    record.releaseRequested = true;
    clearViewTimer(record);
    const operation = viewOperation(async () => {
      let viewError: unknown;
      if (record.view) {
        try {
          await adapter.close_view(record.view);
          forgetView(record);
        } catch (error) {
          viewError = error;
        }
      }
      const sessionError = await closeSession(record);
      if (viewError || sessionError) {
        const cause = sessionError ?? viewError;
        const detail = cause instanceof Error ? cause.message : String(cause);
        record.snapshot = {
          ...record.snapshot,
          sessionState: "disconnected",
          sessionActivity: `Worker cleanup failed (${detail}); retry release or stop_subagent.`,
        };
        changed();
        throw new Error(
          `Could not release subagent ${id} (${detail}); retry release.`,
          { cause },
        );
      }
      record.snapshot = {
        ...record.snapshot,
        capabilities: {
          ...(record.session?.capabilities ??
            record.snapshot.capabilities ??
            record.runtime.capabilities),
        },
      };
      record.session = undefined;
      record.options = {
        ...record.options,
        context: undefined,
        parentSession: undefined,
      };
      changed();
    });
    record.releasing = operation;
    const settled = () => {
      record.releasing = undefined;
    };
    void operation.then(settled, settled);
    return operation;
  };

  const autoRelease = (record: AgentRecord): void => {
    if (!canAutoRelease(record, disposed)) return;
    const execution = record.execution;
    void viewOperation(async () => {
      if (record.execution !== execution || !canAutoRelease(record, disposed)) {
        return;
      }
      if (await liveView(record)) {
        scheduleViewCheck(record);
      } else if (
        record.execution === execution &&
        canAutoRelease(record, disposed)
      ) {
        // Do not await release from inside the serialized view operation.
        void release(record.snapshot.id).catch(() => undefined);
      }
    }).catch(() => scheduleViewCheck(record));
  };

  const finish = (
    record: AgentRecord,
    status: AgentStatus,
    error?: string,
  ): void => {
    const execution = record.execution;
    if (execution.finished) return;
    const wasActive = record.snapshot.status !== "queued";
    execution.finished = true;
    clearTimeout(record.cancelTimer);
    record.cancelTimer = undefined;
    record.snapshot = {
      ...record.snapshot,
      status,
      error,
      completedAt: Date.now(),
    };
    if (wasActive) active -= 1;
    execution.snapshot = snapshot(record);
    execution.resolve(execution.snapshot);
    notify(record, execution);
    changed();
    pump();
    autoRelease(record);
  };

  const terminate = (
    record: AgentRecord,
    status: "stopped" | "error",
    error?: string,
  ): Promise<void> => {
    if (record.terminating) return record.terminating;
    const operation = viewOperation(async () => {
      // View ownership is independent from the runtime's execution resources.
      let viewError: unknown;
      if (record.view) {
        try {
          await adapter.close_view(record.view);
          forgetView(record);
        } catch (cause) {
          // Runtime cleanup must still run if a detached view cannot be closed.
          viewError = cause;
        }
      }
      const sessionError = await closeSession(record);
      if (!sessionError && !viewError) {
        finish(record, status, error);
      } else {
        const cause = sessionError ?? viewError;
        const detail = cause instanceof Error ? cause.message : String(cause);
        record.snapshot = {
          ...record.snapshot,
          sessionState: "disconnected",
          sessionActivity: `Worker cleanup failed (${detail}); retry stop_subagent.`,
          ...(!record.execution.finished
            ? {
                status: "disconnected" as const,
                error: `Worker cleanup failed (${detail}); concurrency slot retained. Retry stop_subagent.`,
              }
            : {}),
        };
        changed();
      }
    });
    record.terminating = operation;
    const clear = () => {
      record.terminating = undefined;
    };
    void operation.then(clear, clear);
    return operation;
  };

  const disconnected = (record: AgentRecord, error: string): void => {
    if (record.snapshot.sessionState === "closed") return;
    record.snapshot = {
      ...record.snapshot,
      sessionState: "disconnected",
      sessionActivity: undefined,
    };
    changed();
    const execution = record.execution;
    if (record.terminating) return;
    // Fresh startup handles its own rejection/cleanup. All other sessions,
    // including idle/native sessions and unacknowledged resumes, are parent-
    // owned and must not survive loss of the control connection.
    if (
      !execution.finished &&
      !execution.reused &&
      record.snapshot.status === "starting"
    ) {
      return;
    }
    void terminate(
      record,
      record.snapshot.status === "stopping" ? "stopped" : "error",
      error,
    );
  };

  const sendFailed = (
    record: AgentRecord,
    execution: Execution,
    error: unknown,
  ): void => {
    if (record.execution !== execution || execution.finished) return;
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof RuntimeTaskRejectedError) {
      // The adapter guarantees no dispatch, unlike an uncertain transport error.
      execution.dispatched = false;
      if (record.snapshot.sessionState === "running") {
        record.snapshot = { ...record.snapshot, sessionState: "idle" };
      }
      finish(record, "error", message);
    } else if (execution.reused && !execution.dispatched) {
      finish(record, "error", message);
    } else {
      disconnected(record, message);
    }
  };

  const send = (
    record: AgentRecord,
    command: RuntimeCommand,
  ): void | Promise<void> => {
    if (!record.session?.connected) {
      throw new Error("Subagent runtime is not connected.");
    }
    // Tasks are already parsed and stamped on acceptance; stamp and validate control frames too.
    if (
      record.execution.round > 1 &&
      command.round !== record.execution.round
    ) {
      command = { ...command, round: record.execution.round };
    }
    if (command.type !== "task") {
      validateCommand(command);
    }
    return record.session.send(command);
  };

  const handleSessionUpdate = (
    record: AgentRecord,
    event: Extract<RuntimeEvent, { type: "session_update" }>,
  ): void => {
    const update = parseSessionUpdateEvent(event);
    if (
      update.sequence <= (record.lastInteractionSequence ?? 0) ||
      record.snapshot.sessionState === "closed" ||
      record.releaseRequested ||
      disposed
    ) {
      return;
    }
    record.lastInteractionSequence = update.sequence;
    // Result ownership is separate from task completion: native work can
    // settle while an older managed turn is still hydrating its final reply.
    if (update.sequence <= (record.lastResultSequence ?? 0)) return;
    const applied = applyResultUpdate(
      record.snapshot,
      record.lastResultSequence,
      {
        response: update.response,
        source: "user_interaction",
        outcome: update.outcome,
        truncated: update.truncated === true,
        error: update.error,
        sequence: update.sequence,
      },
    );
    record.snapshot = applied.snapshot;
    record.lastResultSequence = applied.lastResultSequence;
    changed();
    try {
      options.onSessionUpdate?.(snapshot(record), update);
    } catch {
      // Notification failures must not invalidate the latest reply.
    }
  };

  const handleEvent = (record: AgentRecord, event: RuntimeEvent): void => {
    if (event.type === "session_update") {
      handleSessionUpdate(record, event);
      return;
    }
    if (event.round !== undefined && event.round !== record.execution.round) {
      return;
    }
    if (event.type === "disconnected") {
      disconnected(
        record,
        typeof event.error === "string" ? event.error : "Runtime disconnected.",
      );
      return;
    }
    if (event.type === "model_select") {
      record.snapshot = applyModelMetadata(record.snapshot, event);
      changed();
      return;
    }
    if (event.type === "session_state") {
      if (
        typeof event.state !== "string" ||
        !isBackendSessionState(event.state)
      ) {
        throw new Error("Invalid worker session state");
      }
      if (record.snapshot.sessionState === "closed") return;
      record.snapshot = {
        ...applyModelMetadata(record.snapshot, event),
        sessionState: event.state,
        sessionActivity:
          event.state === "interactive" && typeof event.activity === "string"
            ? event.activity.slice(0, 4096)
            : undefined,
      };
      if (
        event.state === "running" &&
        !record.execution.finished &&
        record.execution.dispatched &&
        (record.execution.round === 1 || event.round === record.execution.round)
      ) {
        record.execution.accepted = true;
      }
      changed();
      if (event.state === "idle") autoRelease(record);
      return;
    }
    if (
      record.execution.finished ||
      (record.execution.round > 1 && event.round !== record.execution.round)
    ) {
      return;
    }
    if (event.type === "started") {
      record.execution.accepted = true;
      record.snapshot = applyModelMetadata(record.snapshot, event);
      changed();
    } else if (event.type === "stats") {
      record.snapshot = applyStatsEvent(record.snapshot, event);
      changed();
    } else if (event.type === "activity") {
      if (typeof event.toolName === "string") {
        record.snapshot = {
          ...record.snapshot,
          activity:
            event.event === "tool_execution_end" ? "Thinking…" : event.toolName,
        };
      }
      changed();
    } else if (event.type === "completed") {
      if (typeof event.result !== "string") {
        throw new Error("Invalid worker result");
      }
      let nextSnapshot =
        record.snapshot.sessionState === "running"
          ? { ...record.snapshot, sessionState: "idle" as const }
          : record.snapshot;
      const applied = applyResultUpdate(
        nextSnapshot,
        record.lastResultSequence,
        {
          response: event.result,
          source: "managed",
          outcome:
            event.canceled === true
              ? "aborted"
              : typeof event.error === "string"
                ? "error"
                : "completed",
          truncated: event.truncated === true,
          error: typeof event.error === "string" ? event.error : undefined,
          sequence:
            typeof event.resultSequence === "number"
              ? event.resultSequence
              : undefined,
        },
      );
      nextSnapshot = applied.snapshot;
      record.lastResultSequence = applied.lastResultSequence;
      if (typeof event.sessionPath === "string") {
        nextSnapshot = { ...nextSnapshot, sessionPath: event.sessionPath };
      }
      record.snapshot = nextSnapshot;
      if (event.canceled === true) finish(record, "stopped");
      else if (typeof event.error === "string") {
        finish(record, "error", event.error);
      } else {
        finish(
          record,
          record.snapshot.status === "stopping" ? "stopped" : "completed",
        );
      }
    } else if (event.type === "error" && typeof event.error === "string") {
      finish(record, "error", event.error);
    }
  };

  const startResumed = async (
    record: AgentRecord,
    execution: Execution,
  ): Promise<void> => {
    try {
      if (!record.session?.connected || !(await record.session.inspect())) {
        throw new Error(
          "Retained runtime is unavailable; no automatic restart.",
        );
      }
      if (record.execution !== execution || execution.finished || disposed) {
        return;
      }
      if (dispatchBlocker(record, "resume")) {
        throw new RuntimeTaskRejectedError(
          "Subagent became unavailable or busy with native/user interaction while resume was queued.",
        );
      }
      record.snapshot = {
        ...record.snapshot,
        status: "running",
        activity: "Thinking…",
      };
      execution.dispatched = true;
      await send(record, execution.command);
      changed();
    } catch (error) {
      sendFailed(record, execution, error);
    }
  };

  const startFresh = async (record: AgentRecord): Promise<void> => {
    const execution = record.execution;
    try {
      // Record ownership before start, including resources acquired on failure.
      record.session = record.runtime.create(
        buildRuntimeOptions(
          record.snapshot.id,
          record.options,
          record.runtime.id,
          options,
        ),
        { mux: adapter, emit: (event) => handleEvent(record, event) },
      );
      await record.session.start();
      if (
        record.execution.finished ||
        disposed ||
        record.snapshot.status === "stopping"
      ) {
        await terminate(record, "stopped");
        return;
      }
      const blocker = dispatchBlocker(record, "startup");
      if (blocker === "disconnected") {
        throw new Error("Subagent runtime disconnected during startup.");
      }
      if (blocker === "busy") {
        throw new RuntimeTaskRejectedError(
          "Managed dispatch requires an idle session; native/user work must settle first.",
        );
      }
      record.snapshot = {
        ...record.snapshot,
        status: "running",
        sessionState: "running",
        activity: "Thinking…",
      };
      changed();
      record.execution.dispatched = true;
      await send(record, execution.command);
    } catch (error) {
      if (record.execution !== execution || execution.finished) return;
      if (error instanceof RuntimeTaskRejectedError) {
        sendFailed(record, execution, error);
        return;
      }
      await terminate(
        record,
        record.snapshot.status === "stopping" ? "stopped" : "error",
        error instanceof Error ? error.message : String(error),
      );
    }
  };

  const pump = (): void => {
    while (!disposed && active < (options.maxConcurrent ?? 4) && queue.length) {
      const entry = queue.shift();
      if (!entry) continue;
      const { record, execution } = entry;
      if (record.execution !== execution || execution.finished) continue;
      active += 1;
      record.snapshot = {
        ...record.snapshot,
        status: "starting",
        startedAt: Date.now(),
      };
      changed();
      const launch = execution.reused
        ? startResumed(record, execution)
        : startFresh(record);
      record.launch = launch;
      launches.add(launch);
      const settled = () => {
        launches.delete(launch);
        if (record.launch === launch) record.launch = undefined;
      };
      void launch.then(settled, settled);
    }
  };

  const closeView = (id: string): Promise<void> => {
    const record = getRecord(id);
    return viewOperation(async () => {
      if (record.view) {
        await adapter.close_view(record.view);
        forgetView(record);
      }
      autoRelease(record);
    });
  };

  const dispose = async (): Promise<void> => {
    disposed = true;
    const pendingCloses: Promise<void>[] = [];
    for (const record of records.values()) {
      record.releaseRequested = true;
      clearViewTimer(record);
      const session = record.session;
      if (session && !closedSessions.has(session)) {
        pendingCloses.push(
          session.close().then(() => {
            closedSessions.add(session);
          }),
        );
      }
      if (!record.execution.finished) finish(record, "stopped");
    }
    await Promise.allSettled([...launches, ...pendingCloses]);
    const cleanup = await Promise.allSettled(
      [...records.values()].map(async (record) => {
        let viewError: unknown;
        try {
          await closeView(record.snapshot.id);
        } catch (error) {
          viewError = error;
        }
        const sessionError = await closeSession(record);
        if (viewError || sessionError) {
          const resources = [
            ...(viewError ? ["view"] : []),
            ...(sessionError ? ["runtime"] : []),
          ].join(" and ");
          throw new Error(
            `Could not clean up subagent ${record.snapshot.id}: ${resources}.`,
            { cause: sessionError ?? viewError },
          );
        }
      }),
    );
    const errors = cleanup.flatMap((result) =>
      result.status === "rejected" ? [result.reason as Error] : [],
    );
    if (errors.length) {
      throw new AggregateError(
        errors,
        `Some subagent terminals could not be cleaned up. ${errors.map((error) => error.message).join(" ")}`,
      );
    }
  };

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    list: () => [...records.values()].map(snapshot),
    get: (id) => snapshot(getRecord(id)),
    runtimeCapabilities: (id) => ({ ...getRuntime(id).capabilities }),
    spawn(spawnOpts) {
      if (disposed) throw new Error("Subagent manager is closed.");
      const runtimeId = spawnOpts.agent?.runtime ?? spawnOpts.runtime ?? "pi";
      const runtime = getRuntime(runtimeId);
      const rawConfig =
        spawnOpts.agent?.runtimeConfig ?? spawnOpts.runtimeConfig ?? {};
      const callConfig = runtime.parseCallConfig?.(
        spawnOpts.runtimeParams ?? {},
        rawConfig,
        "spawn",
      );
      let normalized: SpawnOptions = {
        ...spawnOpts,
        ...(callConfig ??
          (runtime.parseConfig
            ? { runtimeConfig: runtime.parseConfig(rawConfig) }
            : { runtimeConfig: rawConfig })),
        sessionName: `Sub · ${spawnOpts.agent?.name ?? "-"} · ${spawnOpts.description.replace(/\s+/g, " ").trim()}`,
      };
      const id = randomUUID();
      let runtimeOptions = buildRuntimeOptions(
        id,
        normalized,
        runtime.id,
        options,
      );
      runtime.validate(runtimeOptions);
      if (runtime.prepareSpawn) {
        runtimeOptions = runtime.prepareSpawn(runtimeOptions);
        normalized = { ...normalized, ...runtimeOptions };
      }
      const command = parseRuntimeTask(
        runtime,
        taskCommand(normalized),
        runtimeOptions,
      );
      validateCommand(command);
      if (normalized.parentSession && !runtime.capabilities.nativeClone) {
        throw new Error(
          "Cross-runtime context cloning is unsupported by this runtime.",
        );
      }
      const record: AgentRecord = {
        snapshot: createInitialSnapshot(id, runtime, normalized),
        options: normalized,
        runtime,
        execution: createExecution(1, command),
      };
      records.set(record.snapshot.id, record);
      queue.push({ record, execution: record.execution });
      pump();
      changed();
      return snapshot(record);
    },
    backgroundPreference: (id) => getRecord(id).options.agent?.runInBackground,
    resume(id, resumeOpts) {
      if (disposed) throw new Error("Subagent manager is closed.");
      const record = getRecord(id);
      const blocker = resumeBlocker(record);
      if (blocker) throw new Error(blocker);
      const callConfig = record.runtime.parseCallConfig?.(
        resumeOpts.runtimeParams ?? {},
        record.options.runtimeConfig ?? {},
        "resume",
      );
      const next: SpawnOptions = {
        ...record.options,
        ...resumeOpts,
        // The runtime partitions fresh call options; no per-round data is reused.
        runtimeParams: resumeOpts.runtimeParams,
        ...callConfig,
        description: resumeOpts.description ?? record.options.description,
      };
      const round = record.execution.round + 1;
      const command = parseRuntimeTask(
        record.runtime,
        { ...taskCommand(next), round },
        buildRuntimeOptions(id, next, record.runtime.id, options),
      );
      validateCommand(command);
      clearViewTimer(record);
      record.options = next;
      record.execution = createExecution(round, command, true);
      record.snapshot = createResumedSnapshot(
        record.snapshot,
        next.description,
        round,
      );
      queue.push({ record, execution: record.execution });
      pump();
      changed();
      return snapshot(record);
    },
    async result(id, wait = false, signal) {
      const record = getRecord(id);
      const execution = record.execution;
      if (wait && !execution.finished) {
        // Claims and resolved snapshots belong to a round, not the reusable worker.
        execution.waiters += 1;
        try {
          const resolved = await waitFor(execution.completion, signal);
          execution.consumed = true;
          return { ...resolved };
        } finally {
          execution.waiters -= 1;
          if (execution.finished) notify(record, execution);
        }
      }
      if (execution.finished) execution.consumed = true;
      return snapshot(record);
    },
    steer(id, message) {
      if (!message.trim()) {
        throw new Error("Steering message must not be blank.");
      }
      const record = getRecord(id);
      const blocker = steerBlocker(record);
      if (blocker) throw new Error(blocker);
      const sent = send(record, { type: "steer", message });
      // Legacy callers may ignore the return value; parents can await delivery.
      if (sent) void sent.catch(() => undefined);
      return sent;
    },
    stop(id) {
      const record = getRecord(id);
      const execution = record.execution;
      if (execution.finished) {
        if (record.snapshot.sessionState === "disconnected") {
          void terminate(record, "error");
        }
        return snapshot(record);
      }
      if (
        record.snapshot.status === "queued" ||
        (record.execution.reused && !record.execution.dispatched)
      ) {
        finish(record, "stopped");
      } else if (record.snapshot.status !== "stopping") {
        const starting = record.snapshot.status === "starting";
        const isDisconnected = record.snapshot.status === "disconnected";
        record.snapshot = { ...record.snapshot, status: "stopping" };
        if (starting) {
          // Abort startup immediately, even while another agent mutates views.
          const sessionClosing = record.session?.close();
          if (sessionClosing) void sessionClosing.catch(() => undefined);
          void terminate(record, "stopped");
        } else if (isDisconnected || !record.session?.connected) {
          void terminate(record, "stopped");
        } else {
          try {
            const sent = send(record, { type: "cancel" });
            if (sent) {
              void sent.catch((error) => sendFailed(record, execution, error));
            }
          } catch (error) {
            sendFailed(record, execution, error);
          }
          if (record.execution !== execution || execution.finished) {
            changed();
            return snapshot(record);
          }
          record.cancelTimer = setTimeout(() => {
            if (record.execution !== execution || execution.finished) return;
            void terminate(record, "stopped");
          }, options.cancelTimeoutMs ?? 5_000);
        }
      }
      changed();
      return snapshot(record);
    },
    openView(id) {
      const record = getRecord(id);
      record.openingViews = (record.openingViews ?? 0) + 1;
      return viewOperation(async () => {
        checkNativeView(record);
        // Keep TypeScript narrowing at the resource boundary, after ordered policy.
        if (!record.session) {
          throw new Error("Subagent terminal is not ready yet.");
        }
        const terminal = await record.session.attachment();
        checkNativeView(record);
        const hadView = Boolean(record.view);
        const existing = await liveView(record);
        if (hadView) checkNativeView(record);
        if (existing) {
          await adapter.focus_view(existing);
          return existing;
        }
        const view = await adapter.open_view({ terminal });
        record.view = view;
        changed();
        try {
          checkNativeView(record);
        } catch (error) {
          // Only roll back the view created by this operation. Record ownership
          // first so a failed close remains available for cleanup retries.
          try {
            await adapter.close_view(view);
            forgetView(record);
          } catch {
            scheduleViewCheck(record);
          }
          throw error;
        }
        scheduleViewCheck(record);
        return view;
      }).finally(() => {
        record.openingViews = (record.openingViews ?? 1) - 1;
      });
    },
    closeView,
    release,
    async remove(id) {
      const record = getRecord(id);
      // Even a previously stopped startup may still acquire a terminal.
      const launch = record.launch;
      record.releaseRequested = true;
      clearViewTimer(record);
      record.execution.consumed = true;
      clearTimeout(record.cancelTimer);
      record.cancelTimer = undefined;
      // Closing immediately cancels startup; keep the session recorded for retries.
      const sessionClosing = record.session?.close();
      if (sessionClosing) void sessionClosing.catch(() => undefined);
      record.snapshot = { ...record.snapshot, sessionState: "closed" };
      // Drop stale queue references even if this round was already stopped.
      for (let index = queue.length - 1; index >= 0; index -= 1) {
        if (queue[index]?.record === record) queue.splice(index, 1);
      }
      if (record.snapshot.status === "queued") {
        finish(record, "stopped");
      } else if (!record.execution.finished) {
        record.snapshot = { ...record.snapshot, status: "stopping" };
        changed();
      }
      await launch?.catch(() => undefined);
      await viewOperation(async () => {
        if (record.view) {
          await adapter.close_view(record.view);
          forgetView(record);
        }
        const sessionError = await closeSession(record);
        if (sessionError) {
          const detail =
            sessionError instanceof Error
              ? sessionError.message
              : String(sessionError);
          throw new Error(
            `Could not delete subagent ${id} (${detail}); retry deletion.`,
            { cause: sessionError },
          );
        }
        finish(record, "stopped");
        records.delete(id);
        changed();
      });
    },
    close() {
      closing ??= dispose().catch((error) => {
        closing = undefined;
        throw error;
      });
      return closing;
    },
  };
}
