import { randomUUID } from "node:crypto";
import type { WorkerExtensionSource } from "@pi-kits/config";
import type { AgentDefinition } from "./agents.ts";
import type { MuxAdapter, ViewHandle } from "./mux/index.ts";
import { CodexRuntime } from "./runtime/codex/index.ts";
import { RuntimeTaskRejectedError } from "./runtime/errors.ts";
import type {
  AgentRuntime,
  RuntimeCapabilities,
  RuntimeCommand,
  RuntimeEvent,
  RuntimeId,
  RuntimeOptions,
  RuntimeSession,
} from "./runtime/index.ts";
import type { ParentSessionSnapshot } from "./runtime/pi/clone.ts";
import { PiRuntime } from "./runtime/pi/index.ts";
import {
  isWorkerSessionState,
  MAX_COMMAND_BYTES,
  type WorkerSessionState,
} from "./runtime/pi/protocol.ts";

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

export interface AgentSnapshot {
  id: string;
  description: string;
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
  result?: string;
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
  parentSession?: ParentSessionSnapshot;
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
  viewTimer?: ReturnType<typeof setTimeout>;
}

interface Execution {
  round: number;
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

export interface ResumeOptions {
  prompt: string;
  runtimeParams?: Record<string, unknown>;
  description?: string;
}

export interface ManagerOptions {
  runtimes?: readonly AgentRuntime[];
  maxConcurrent?: number;
  extensionAllowlist?: readonly WorkerExtensionSource[];
  startupTimeoutMs?: number;
  cancelTimeoutMs?: number;
  workerPath?: string;
  executable?: string;
  runtimeExecutables?: Partial<Record<RuntimeId, string>>;
  onComplete?: (snapshot: AgentSnapshot) => void;
}

const terminalStatus = (status: AgentStatus) =>
  status === "completed" || status === "stopped" || status === "error";

/** Owns managed rounds and view placement; runtimes own execution resources. */
export class SubagentManager {
  private readonly records = new Map<string, AgentRecord>();
  private readonly listeners = new Set<() => void>();
  private readonly views = new Map<string, AgentRecord>();
  private viewMutation: Promise<void> = Promise.resolve();
  private readonly queue: { record: AgentRecord; execution: Execution }[] = [];
  private readonly runtimes = new Map<RuntimeId, AgentRuntime>();
  private readonly launches = new Set<Promise<void>>();
  private readonly closedSessions = new WeakSet<RuntimeSession>();
  private active = 0;
  private disposed = false;
  private closing?: Promise<void>;

  constructor(
    private readonly adapter: MuxAdapter,
    private readonly options: ManagerOptions = {},
  ) {
    for (const runtime of [
      new PiRuntime(),
      new CodexRuntime(),
      ...(options.runtimes ?? []),
    ]) {
      this.runtimes.set(runtime.id, runtime);
    }
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // A view/render failure must never alter task execution.
      }
    }
  }

  list(): AgentSnapshot[] {
    return [...this.records.values()].map((record) => this.snapshot(record));
  }

  get(id: string): AgentSnapshot {
    return this.snapshot(this.record(id));
  }

  runtimeCapabilities(id: RuntimeId): RuntimeCapabilities {
    return { ...this.runtime(id).capabilities };
  }

  private runtime(id: RuntimeId): AgentRuntime {
    const runtime = this.runtimes.get(id);
    if (!runtime) throw new Error(`Unknown subagent runtime: ${id}`);
    return runtime;
  }

  spawn(options: SpawnOptions): AgentSnapshot {
    if (this.disposed) throw new Error("Subagent manager is closed.");
    const runtimeId = options.agent?.runtime ?? options.runtime ?? "pi";
    const runtime = this.runtime(runtimeId);
    const rawConfig =
      options.agent?.runtimeConfig ?? options.runtimeConfig ?? {};
    const callConfig = runtime.parseCallConfig?.(
      options.runtimeParams ?? {},
      rawConfig,
      "spawn",
    );
    options = {
      ...options,
      ...(callConfig ??
        (runtime.parseConfig
          ? { runtimeConfig: runtime.parseConfig(rawConfig) }
          : { runtimeConfig: rawConfig })),
    };
    options = {
      ...options,
      sessionName: `Sub · ${options.agent?.name ?? "-"} · ${options.description.replace(/\s+/g, " ").trim()}`,
    };
    const id = randomUUID();
    let runtimeOptions = this.runtimeOptions(id, options, runtime.id);
    runtime.validate(runtimeOptions);
    if (runtime.prepareSpawn) {
      runtimeOptions = runtime.prepareSpawn(runtimeOptions);
      options = { ...options, ...runtimeOptions };
    }
    validateCommand(
      this.parseTask(runtime, taskCommand(options), runtimeOptions),
    );
    if (options.parentSession && !runtime.capabilities.nativeClone) {
      throw new Error(
        "Cross-runtime context cloning is unsupported by this runtime.",
      );
    }
    const record: AgentRecord = {
      snapshot: {
        id,
        runtime: runtime.id,
        runtimeName: runtime.displayName,
        capabilities: { ...runtime.capabilities },
        description: options.description,
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
        createdAt: Date.now(),
        turnCount: 0,
        toolUses: 0,
        totalTokens: 0,
        compactionCount: 0,
      },
      options,
      runtime,
      execution: createExecution(1),
    };
    this.records.set(record.snapshot.id, record);
    this.queue.push({ record, execution: record.execution });
    this.pump();
    this.changed();
    return this.snapshot(record);
  }

  backgroundPreference(id: string): boolean | undefined {
    return this.record(id).options.agent?.runInBackground;
  }

  resume(id: string, options: ResumeOptions): AgentSnapshot {
    if (this.disposed) throw new Error("Subagent manager is closed.");
    const record = this.record(id);
    if (record.releaseRequested || record.snapshot.sessionState === "closed") {
      throw new Error(
        "Subagent runtime is closed/released; no connected worker remains.",
      );
    }
    if (!record.execution.finished) {
      throw new Error("Only a finished managed task can be resumed.");
    }
    if (
      record.openingViews &&
      !record.runtime.capabilities.concurrentNativeInput
    ) {
      throw new Error(
        "Native view opening is still in progress; resume is unavailable.",
      );
    }
    if (record.terminating) {
      throw new Error(
        "Worker cleanup is still in progress; resume is unavailable.",
      );
    }
    if (
      !record.session?.connected ||
      !record.session.capabilities.retainedSession
    ) {
      throw new Error(
        "Resume requires a retained, connected runtime; no automatic restart.",
      );
    }
    if (record.snapshot.sessionState !== "idle") {
      throw new Error(
        "Resume requires an idle session; wait for native/user interaction to settle.",
      );
    }
    const callConfig = record.runtime.parseCallConfig?.(
      options.runtimeParams ?? {},
      record.options.runtimeConfig ?? {},
      "resume",
    );
    const next = {
      ...record.options,
      ...options,
      // The runtime partitions fresh call options; no per-round data is reused.
      runtimeParams: options.runtimeParams,
      ...callConfig,
    };
    next.description = options.description ?? record.options.description;
    const round = record.execution.round + 1;
    if (!Number.isSafeInteger(round))
      throw new Error("Subagent round limit reached.");
    validateCommand(
      this.parseTask(
        record.runtime,
        { ...taskCommand(next), round },
        this.runtimeOptions(id, next, record.runtime.id),
      ),
    );
    this.clearViewTimer(record);
    record.options = next;
    record.execution = createExecution(round, true);
    record.snapshot = {
      ...record.snapshot,
      description: next.description,
      round,
      status: "queued",
      result: undefined,
      error: undefined,
      truncated: undefined,
      activity: undefined,
      sessionActivity: undefined,
      createdAt: Date.now(),
      startedAt: undefined,
      completedAt: undefined,
      turnCount: 0,
      toolUses: 0,
      totalTokens: 0,
      contextPercent: undefined,
      compactionCount: 0,
    };
    this.queue.push({ record, execution: record.execution });
    this.pump();
    this.changed();
    return this.snapshot(record);
  }

  async result(id: string, wait = false, signal?: AbortSignal) {
    const record = this.record(id);
    const execution = record.execution;
    if (wait && !execution.finished) {
      // Claims and resolved snapshots belong to a round, not the reusable worker.
      execution.waiters += 1;
      try {
        const snapshot = await waitFor(execution.completion, signal);
        execution.consumed = true;
        return { ...snapshot };
      } finally {
        execution.waiters -= 1;
        if (execution.finished) this.notify(record, execution);
      }
    }
    if (execution.finished) execution.consumed = true;
    return this.snapshot(record);
  }

  steer(id: string, message: string): void | Promise<void> {
    if (!message.trim()) throw new Error("Steering message must not be blank.");
    const record = this.record(id);
    if (record.snapshot.status !== "running") {
      throw new Error("Only a running subagent can be steered.");
    }
    if (!record.runtime.capabilities.steer) {
      throw new Error("This runtime does not support steering.");
    }
    const sent = this.send(record, { type: "steer", message });
    // Legacy callers may ignore the return value; parents can await delivery.
    if (sent) void sent.catch(() => undefined);
    return sent;
  }

  stop(id: string): AgentSnapshot {
    const record = this.record(id);
    const execution = record.execution;
    if (execution.finished) {
      if (record.snapshot.sessionState === "disconnected") {
        void this.terminate(record, "error");
      }
      return this.snapshot(record);
    }
    if (
      record.snapshot.status === "queued" ||
      (record.execution.reused && !record.execution.dispatched)
    ) {
      this.finish(record, "stopped");
    } else if (record.snapshot.status !== "stopping") {
      const starting = record.snapshot.status === "starting";
      const disconnected = record.snapshot.status === "disconnected";
      record.snapshot.status = "stopping";
      if (starting) {
        // Abort startup immediately, even while another agent mutates views.
        const closing = record.session?.close();
        if (closing) void closing.catch(() => undefined);
        void this.terminate(record, "stopped");
      } else if (disconnected || !record.session?.connected) {
        void this.terminate(record, "stopped");
      } else {
        try {
          const sent = this.send(record, { type: "cancel" });
          if (sent) {
            void sent.catch((error) =>
              this.sendFailed(record, execution, error),
            );
          }
        } catch (error) {
          this.sendFailed(record, execution, error);
        }
        if (record.execution !== execution || execution.finished) {
          this.changed();
          return this.snapshot(record);
        }
        record.cancelTimer = setTimeout(() => {
          if (record.execution !== execution || execution.finished) return;
          void this.terminate(record, "stopped");
        }, this.options.cancelTimeoutMs ?? 5_000);
      }
    }
    this.changed();
    return this.snapshot(record);
  }

  openView(id: string) {
    const record = this.record(id);
    record.openingViews = (record.openingViews ?? 0) + 1;
    return this.viewOperation(async () => {
      if (this.disposed) throw new Error("Subagent manager is closed.");
      if (
        record.releaseRequested ||
        record.snapshot.sessionState === "closed" ||
        record.terminating ||
        (record.session && this.closedSessions.has(record.session))
      ) {
        throw new Error("Subagent runtime is closed/released.");
      }
      if (!record.session) {
        throw new Error("Subagent terminal is not ready yet.");
      }
      if (
        !record.execution.finished &&
        !record.session.capabilities.concurrentNativeInput
      ) {
        throw new Error(
          "Native attachment requires no managed task; wait for this round to finish.",
        );
      }
      const terminal = await record.session.attachment();
      if (this.disposed || record.releaseRequested) {
        throw new Error("Subagent runtime is closed/released.");
      }
      const existing = await this.liveView(record);
      if (existing) {
        await this.adapter.focus_view(existing);
        return existing;
      }
      let relativeTo: ViewHandle | undefined;
      for (const previous of [...this.views.values()].reverse()) {
        relativeTo = await this.liveView(previous);
        if (relativeTo) break;
      }
      // Layout policy belongs here, not in any adapter: first right of the
      // parent, every subsequent view below the last surviving attachment.
      const view = await this.adapter.open_view(
        relativeTo
          ? { terminal, direction: "down", relativeTo }
          : { terminal, direction: "right" },
      );
      record.view = view;
      this.views.set(view.id, record);
      this.scheduleViewCheck(record);
      this.changed();
      if (this.disposed || record.releaseRequested) {
        throw new Error("Subagent runtime is closed/released.");
      }
      return view;
    }).finally(() => {
      record.openingViews = (record.openingViews ?? 1) - 1;
    });
  }

  closeView(id: string): Promise<void> {
    const record = this.record(id);
    return this.viewOperation(async () => {
      if (record.view) {
        await this.adapter.close_view(record.view);
        this.forgetView(record);
      }
      this.autoRelease(record);
    });
  }

  /** Close resources while preserving the managed record and round results. */
  release(id: string): Promise<void> {
    const record = this.record(id);
    if (record.releasing) return record.releasing;
    if (!record.execution.finished) {
      return Promise.reject(
        new Error("Only a finished managed task can be released."),
      );
    }
    record.releaseRequested = true;
    this.clearViewTimer(record);
    const operation = this.viewOperation(async () => {
      let viewClosed = true;
      if (record.view) {
        try {
          await this.adapter.close_view(record.view);
          this.forgetView(record);
        } catch {
          viewClosed = false;
        }
      }
      const sessionClosed = await this.closeSession(record);
      if (!viewClosed || !sessionClosed) {
        record.snapshot.sessionState = "disconnected";
        record.snapshot.sessionActivity =
          "Worker cleanup failed; retry release or stop_subagent.";
        this.changed();
        throw new Error(`Could not release subagent ${id}; retry release.`);
      }
      record.snapshot.capabilities = {
        ...(record.session?.capabilities ??
          record.snapshot.capabilities ??
          record.runtime.capabilities),
      };
      record.session = undefined;
      record.options = {
        ...record.options,
        context: undefined,
        parentSession: undefined,
      };
      this.changed();
    });
    record.releasing = operation;
    const settled = () => {
      record.releasing = undefined;
    };
    void operation.then(settled, settled);
    return operation;
  }

  private clearViewTimer(record: AgentRecord): void {
    clearTimeout(record.viewTimer);
    record.viewTimer = undefined;
  }

  private scheduleViewCheck(record: AgentRecord): void {
    if (
      this.disposed ||
      record.releaseRequested ||
      record.snapshot.keepAlive ||
      !record.execution.finished ||
      !record.view ||
      record.viewTimer
    )
      return;
    record.viewTimer = setTimeout(() => {
      record.viewTimer = undefined;
      this.autoRelease(record);
    }, 1_000);
    record.viewTimer.unref();
  }

  private autoRelease(record: AgentRecord): void {
    if (
      this.disposed ||
      record.releaseRequested ||
      record.snapshot.keepAlive ||
      !record.execution.finished ||
      record.snapshot.sessionState === "closed"
    )
      return;
    const execution = record.execution;
    void this.viewOperation(async () => {
      if (
        this.disposed ||
        record.releaseRequested ||
        record.execution !== execution ||
        !execution.finished ||
        record.snapshot.sessionState === "closed"
      )
        return;
      if (await this.liveView(record)) {
        this.scheduleViewCheck(record);
      } else if (record.execution === execution && execution.finished) {
        // Do not await release from inside the serialized view operation.
        void this.release(record.snapshot.id).catch(() => undefined);
      }
    }).catch(() => this.scheduleViewCheck(record));
  }

  /** Close native resources and forget the agent, never its session files. */
  async remove(id: string): Promise<void> {
    const record = this.record(id);
    // Even a previously stopped startup may still acquire a terminal.
    const launch = record.launch;
    record.releaseRequested = true;
    this.clearViewTimer(record);
    record.execution.consumed = true;
    clearTimeout(record.cancelTimer);
    record.cancelTimer = undefined;
    // Closing immediately cancels startup; keep the session recorded for retries.
    const closing = record.session?.close();
    if (closing) void closing.catch(() => undefined);
    record.snapshot.sessionState = "closed";
    // Drop stale queue references even if this round was already stopped.
    for (let index = this.queue.length - 1; index >= 0; index -= 1) {
      if (this.queue[index]?.record === record) this.queue.splice(index, 1);
    }
    if (record.snapshot.status === "queued") {
      this.finish(record, "stopped");
    } else if (!record.execution.finished) {
      record.snapshot.status = "stopping";
      this.changed();
    }
    await launch?.catch(() => undefined);
    await this.viewOperation(async () => {
      if (record.view) {
        await this.adapter.close_view(record.view);
        this.forgetView(record);
      }
      if (!(await this.closeSession(record))) {
        throw new Error(`Could not delete subagent ${id}; retry deletion.`);
      }
      this.finish(record, "stopped");
      this.records.delete(id);
      this.changed();
    });
  }

  private forgetView(record: AgentRecord): void {
    this.clearViewTimer(record);
    if (record.view) this.views.delete(record.view.id);
    record.view = undefined;
    this.changed();
  }

  private async liveView(record: AgentRecord): Promise<ViewHandle | undefined> {
    if (record.view && !(await this.adapter.inspect_view(record.view)).alive) {
      await this.adapter.close_view(record.view);
      this.forgetView(record);
      this.autoRelease(record);
    }
    return record.view;
  }

  private viewOperation<T>(action: () => Promise<T>) {
    // Different agents share one column, so serialize across all records.
    const result = this.viewMutation.then(action);
    this.viewMutation = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  close(): Promise<void> {
    this.closing ??= this.dispose().catch((error) => {
      this.closing = undefined;
      throw error;
    });
    return this.closing;
  }

  private async dispose(): Promise<void> {
    this.disposed = true;
    const closing: Promise<void>[] = [];
    for (const record of this.records.values()) {
      record.releaseRequested = true;
      this.clearViewTimer(record);
      const session = record.session;
      if (session && !this.closedSessions.has(session)) {
        closing.push(
          session.close().then(() => {
            this.closedSessions.add(session);
          }),
        );
      }
      if (!record.execution.finished) this.finish(record, "stopped");
    }
    await Promise.allSettled([...this.launches, ...closing]);
    const cleanup = await Promise.allSettled(
      [...this.records.values()].map(async (record) => {
        const viewClosed = await this.closeView(record.snapshot.id).then(
          () => true,
          () => false,
        );
        const terminalClosed = await this.closeSession(record);
        if (!viewClosed || !terminalClosed) {
          const resources = [
            ...(!viewClosed ? ["view"] : []),
            ...(!terminalClosed ? ["runtime"] : []),
          ].join(" and ");
          throw new Error(
            `Could not clean up subagent ${record.snapshot.id}: ${resources}.`,
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
  }

  private record(id: string): AgentRecord {
    const record = this.records.get(id);
    if (!record) throw new Error(`Unknown subagent: ${id}`);
    return record;
  }

  private snapshot(record: AgentRecord): AgentSnapshot {
    return {
      ...record.snapshot,
      capabilities: {
        ...(record.session?.capabilities ??
          record.snapshot.capabilities ??
          record.runtime.capabilities),
      },
      terminalId:
        record.snapshot.sessionState === "closed" ||
        (record.session && this.closedSessions.has(record.session))
          ? undefined
          : record.session?.terminal?.id,
      viewId: record.view?.id,
    };
  }

  private pump(): void {
    while (
      !this.disposed &&
      this.active < (this.options.maxConcurrent ?? 4) &&
      this.queue.length
    ) {
      const entry = this.queue.shift();
      if (!entry) continue;
      const { record, execution } = entry;
      if (record.execution !== execution || execution.finished) continue;
      this.active += 1;
      record.snapshot.status = "starting";
      record.snapshot.startedAt = Date.now();
      this.changed();
      const launch = execution.reused
        ? this.startResumed(record, execution)
        : this.start(record);
      record.launch = launch;
      this.launches.add(launch);
      const settled = () => {
        this.launches.delete(launch);
        if (record.launch === launch) record.launch = undefined;
      };
      void launch.then(settled, settled);
    }
  }

  private async startResumed(
    record: AgentRecord,
    execution: Execution,
  ): Promise<void> {
    try {
      if (!record.session?.connected || !(await record.session.inspect())) {
        throw new Error(
          "Retained runtime is unavailable; no automatic restart.",
        );
      }
      if (record.execution !== execution || execution.finished || this.disposed)
        return;
      if (record.snapshot.sessionState !== "idle") {
        throw new Error(
          "Subagent became busy with native/user interaction while resume was queued.",
        );
      }
      record.snapshot.status = "running";
      record.snapshot.activity = "Thinking…";
      execution.dispatched = true;
      await this.send(record, taskCommand(record.options));
      this.changed();
    } catch (error) {
      this.sendFailed(record, execution, error);
    }
  }

  private runtimeOptions(
    id: string,
    options: SpawnOptions,
    runtimeId: RuntimeId,
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
      extensionAllowlist:
        runtimeId === "pi" ? this.options.extensionAllowlist : undefined,
      executable:
        this.options.runtimeExecutables?.[runtimeId] ??
        (runtimeId === "pi" ? this.options.executable : undefined),
      workerPath: runtimeId === "pi" ? this.options.workerPath : undefined,
      startupTimeoutMs: this.options.startupTimeoutMs,
    };
  }

  private async start(record: AgentRecord): Promise<void> {
    const execution = record.execution;
    try {
      // Record ownership before start, including resources acquired on failure.
      record.session = record.runtime.create(
        this.runtimeOptions(
          record.snapshot.id,
          record.options,
          record.runtime.id,
        ),
        { mux: this.adapter, emit: (event) => this.event(record, event) },
      );
      await record.session.start();
      if (
        record.execution.finished ||
        this.disposed ||
        record.snapshot.status === "stopping"
      ) {
        await this.terminate(record, "stopped");
        return;
      }
      record.snapshot.status = "running";
      if (record.snapshot.sessionState !== "interactive") {
        record.snapshot.sessionState = "running";
      }
      record.snapshot.activity = "Thinking…";
      this.changed();
      record.execution.dispatched = true;
      await this.send(record, taskCommand(record.options));
    } catch (error) {
      if (record.execution !== execution || execution.finished) return;
      if (error instanceof RuntimeTaskRejectedError) {
        this.sendFailed(record, execution, error);
        return;
      }
      await this.terminate(
        record,
        record.snapshot.status === "stopping" ? "stopped" : "error",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private async closeSession(record: AgentRecord): Promise<boolean> {
    try {
      const session = record.session;
      if (session && !this.closedSessions.has(session)) {
        await session.close();
        this.closedSessions.add(session);
      }
      record.snapshot.sessionState = "closed";
      record.snapshot.sessionActivity = undefined;
      return true;
    } catch {
      // Retain ownership and the concurrency slot until cleanup can be retried.
      record.snapshot.sessionState = "disconnected";
      record.snapshot.sessionActivity =
        "Worker cleanup failed; retry stop_subagent.";
      this.changed();
      return false;
    }
  }

  private terminate(
    record: AgentRecord,
    status: "stopped" | "error",
    error?: string,
  ): Promise<void> {
    if (record.terminating) return record.terminating;
    const operation = this.viewOperation(async () => {
      // View ownership is independent from the runtime's execution resources.
      let viewClosed = true;
      if (record.view) {
        try {
          await this.adapter.close_view(record.view);
          this.forgetView(record);
        } catch {
          // Runtime cleanup must still run if a detached view cannot be closed.
          viewClosed = false;
        }
      }
      const sessionClosed = await this.closeSession(record);
      if (sessionClosed && viewClosed) {
        this.finish(record, status, error);
      } else {
        record.snapshot.sessionState = "disconnected";
        record.snapshot.sessionActivity =
          "Worker cleanup failed; retry stop_subagent.";
        if (!record.execution.finished) {
          record.snapshot.status = "disconnected";
          record.snapshot.error =
            "Worker cleanup failed; concurrency slot retained. Retry stop_subagent.";
        }
        this.changed();
      }
    });
    record.terminating = operation;
    void operation.then(
      () => {
        record.terminating = undefined;
      },
      () => {
        record.terminating = undefined;
      },
    );
    return operation;
  }

  private disconnected(record: AgentRecord, error: string): void {
    if (record.snapshot.sessionState === "closed") return;
    record.snapshot.sessionState = "disconnected";
    record.snapshot.sessionActivity = undefined;
    this.changed();
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
    void this.terminate(
      record,
      record.snapshot.status === "stopping" ? "stopped" : "error",
      error,
    );
  }

  private sendFailed(
    record: AgentRecord,
    execution: Execution,
    error: unknown,
  ): void {
    if (record.execution !== execution || execution.finished) return;
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof RuntimeTaskRejectedError) {
      // The adapter guarantees no dispatch, unlike an uncertain transport error.
      execution.dispatched = false;
      if (record.snapshot.sessionState === "running") {
        record.snapshot.sessionState = "idle";
      }
      this.finish(record, "error", message);
    } else if (execution.reused && !execution.dispatched) {
      this.finish(record, "error", message);
    } else {
      this.disconnected(record, message);
    }
  }

  private event(record: AgentRecord, event: RuntimeEvent): void {
    if (event.round !== undefined && event.round !== record.execution.round)
      return;
    if (event.type === "disconnected") {
      this.disconnected(
        record,
        typeof event.error === "string" ? event.error : "Runtime disconnected.",
      );
      return;
    }
    if (event.type === "model_select") {
      updateModelMetadata(record.snapshot, event);
      this.changed();
      return;
    }
    if (event.type === "session_state") {
      if (
        typeof event.state !== "string" ||
        !isWorkerSessionState(event.state)
      ) {
        throw new Error("Invalid worker session state");
      }
      if (record.snapshot.sessionState === "closed") return;
      updateModelMetadata(record.snapshot, event);
      record.snapshot.sessionState = event.state;
      if (
        event.state === "running" &&
        !record.execution.finished &&
        record.execution.dispatched &&
        (record.execution.round === 1 || event.round === record.execution.round)
      ) {
        record.execution.accepted = true;
      }
      record.snapshot.sessionActivity =
        event.state === "interactive" && typeof event.activity === "string"
          ? event.activity.slice(0, 4096)
          : undefined;
      this.changed();
      return;
    }
    if (
      record.execution.finished ||
      (record.execution.round > 1 && event.round !== record.execution.round)
    )
      return;
    if (event.type === "started") {
      record.execution.accepted = true;
      updateModelMetadata(record.snapshot, event);
      this.changed();
    }
    if (event.type === "stats") {
      updateModelMetadata(record.snapshot, event);
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
          record.snapshot[key] = value;
        }
      }
      record.snapshot.contextPercent = undefined;
      if (
        typeof event.contextPercent === "number" &&
        Number.isFinite(event.contextPercent) &&
        event.contextPercent >= 0 &&
        event.contextPercent <= 100
      ) {
        record.snapshot.contextPercent = event.contextPercent;
      }
      this.changed();
    }
    if (event.type === "activity") {
      if (typeof event.toolName === "string") {
        record.snapshot.activity =
          event.event === "tool_execution_end" ? "Thinking…" : event.toolName;
      }
      this.changed();
    }
    if (event.type === "completed") {
      if (typeof event.result !== "string") {
        throw new Error("Invalid worker result");
      }
      if (record.snapshot.sessionState === "running") {
        record.snapshot.sessionState = "idle";
      }
      record.snapshot.result = event.result;
      record.snapshot.truncated = event.truncated === true;
      if (typeof event.sessionPath === "string") {
        record.snapshot.sessionPath = event.sessionPath;
      }
      if (event.canceled === true) this.finish(record, "stopped");
      else if (typeof event.error === "string") {
        this.finish(record, "error", event.error);
      } else {
        this.finish(
          record,
          record.snapshot.status === "stopping" ? "stopped" : "completed",
        );
      }
    }
    if (event.type === "error" && typeof event.error === "string") {
      this.finish(record, "error", event.error);
    }
  }

  private send(
    record: AgentRecord,
    command: RuntimeCommand,
  ): void | Promise<void> {
    if (!record.session?.connected) {
      throw new Error("Subagent runtime is not connected.");
    }
    // Stamp before parsing/delivery so acceptance and dispatch see the same round.
    if (record.execution.round > 1)
      command = { ...command, round: record.execution.round };
    command = this.parseTask(
      record.runtime,
      command,
      this.runtimeOptions(
        record.snapshot.id,
        record.options,
        record.runtime.id,
      ),
    );
    validateCommand(command);
    return record.session.send(command);
  }

  private parseTask(
    runtime: AgentRuntime,
    command: RuntimeCommand,
    options: RuntimeOptions,
  ): RuntimeCommand {
    if (runtime.parseTask) return runtime.parseTask(command, options);
    if (command.type === "task") {
      if (!command.prompt.trim())
        throw new Error("Task prompt must not be blank.");
    }
    return command;
  }

  private finish(record: AgentRecord, status: AgentStatus, error?: string) {
    const execution = record.execution;
    if (execution.finished) return;
    const wasActive = record.snapshot.status !== "queued";
    execution.finished = true;
    clearTimeout(record.cancelTimer);
    record.cancelTimer = undefined;
    record.snapshot.status = status;
    record.snapshot.error = error;
    record.snapshot.completedAt = Date.now();
    if (wasActive) this.active -= 1;
    execution.snapshot = this.snapshot(record);
    execution.resolve(execution.snapshot);
    this.notify(record, execution);
    this.changed();
    this.pump();
    this.autoRelease(record);
  }

  private notify(record: AgentRecord, execution = record.execution): void {
    if (
      this.disposed ||
      execution.consumed ||
      execution.waiters > 0 ||
      execution.notified
    ) {
      return;
    }
    execution.notified = true;
    try {
      this.options.onComplete?.({
        ...(execution.snapshot ?? this.snapshot(record)),
      });
    } catch {
      // A parent notification failure cannot invalidate a completed task.
    }
  }
}

/** Ignore malformed optional metadata without replacing the last known model. */
function updateModelMetadata(
  snapshot: AgentSnapshot,
  event: Record<string, unknown>,
): void {
  if (typeof event.runtimeSessionId === "string") {
    snapshot.runtimeSessionId = event.runtimeSessionId;
  }
  if (typeof event.sessionPath === "string") {
    snapshot.sessionPath = event.sessionPath;
  }
  const validText = (value: unknown): value is string =>
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= 4096 &&
    !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(value);
  if (validText(event.model)) {
    if (event.model !== snapshot.model) snapshot.modelName = undefined;
    snapshot.model = event.model;
  }
  if (
    validText(event.modelName) &&
    (event.model === undefined || validText(event.model))
  ) {
    snapshot.modelName = event.modelName;
  }
}

function createExecution(round: number, reused = false): Execution {
  let resolve: Execution["resolve"] = () => undefined;
  const completion = new Promise<AgentSnapshot>((done) => {
    resolve = done;
  });
  return {
    round,
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

export function isTerminalStatus(status: AgentStatus): boolean {
  return terminalStatus(status);
}
