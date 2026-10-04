import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";
import { fileURLToPath } from "node:url";
import {
  SUBAGENT_DEFAULT_EXTENSIONS,
  type WorkerExtensionSource,
} from "@pi-kits/config";
import type { AgentDefinition } from "./agents.ts";
import { createClonedSession, type ParentSessionSnapshot } from "./clone.ts";
import { resolveWorkerExtensions } from "./extensions.ts";
import {
  type MuxAdapter,
  type TerminalHandle,
  TerminalStartError,
  type ViewHandle,
} from "./mux.ts";
import {
  isWorkerSessionState,
  MAX_COMMAND_BYTES,
  type WorkerSessionState,
} from "./protocol.ts";

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
  sessionState?: SessionState;
  sessionActivity?: string;
  subagentType?: string;
  displayName?: string;
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
  prompt: string;
  description: string;
  cwd: string;
  model?: string;
  thinking?: string;
  agent?: AgentDefinition;
  parentSession?: ParentSessionSnapshot;
}

interface AgentRecord {
  snapshot: AgentSnapshot;
  options: SpawnOptions;
  token: string;
  terminal?: TerminalHandle;
  view?: ViewHandle;
  socket?: Socket;
  execution: Execution;
  ready?: () => void;
  rejectReady?: (error: Error) => void;
  cancelTimer?: ReturnType<typeof setTimeout>;
  terminating?: Promise<void>;
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
  description?: string;
}

export interface ManagerOptions {
  maxConcurrent?: number;
  extensionAllowlist?: readonly WorkerExtensionSource[];
  startupTimeoutMs?: number;
  cancelTimeoutMs?: number;
  workerPath?: string;
  executable?: string;
  onComplete?: (snapshot: AgentSnapshot) => void;
}

const MAX_FRAME_BYTES = 1_048_576;
const terminalStatus = (status: AgentStatus) =>
  status === "completed" || status === "stopped" || status === "error";

/** Owns tasks and IPC; the mux owns PTYs, screens, and native terminal input. */
export class SubagentManager {
  private readonly records = new Map<string, AgentRecord>();
  private readonly listeners = new Set<() => void>();
  private readonly views = new Map<string, AgentRecord>();
  private viewMutation: Promise<void> = Promise.resolve();
  private readonly queue: { record: AgentRecord; execution: Execution }[] = [];
  private readonly sockets = new Set<Socket>();
  private readonly launches = new Set<Promise<void>>();
  private server?: Server;
  private endpoint?: Promise<string>;
  private active = 0;
  private disposed = false;
  private closing?: Promise<void>;

  constructor(
    private readonly adapter: MuxAdapter,
    private readonly options: ManagerOptions = {},
  ) {}

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

  spawn(options: SpawnOptions): AgentSnapshot {
    if (this.disposed) throw new Error("Subagent manager is closed.");
    if (!options.prompt.trim()) {
      throw new Error("Task prompt must not be blank.");
    }
    validateCommand(taskCommand(options));
    const record: AgentRecord = {
      snapshot: {
        id: randomUUID(),
        description: options.description,
        status: "queued",
        round: 1,
        inheritedContext: Boolean(options.parentSession),
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
      token: randomBytes(32).toString("hex"),
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
    if (!record.execution.finished) {
      throw new Error("Only a finished managed task can be resumed.");
    }
    if (record.terminating) {
      throw new Error(
        "Worker cleanup is still in progress; resume is unavailable.",
      );
    }
    if (!record.terminal || !record.socket || record.socket.destroyed) {
      throw new Error(
        "Resume requires a retained, connected Pi worker; no automatic restart.",
      );
    }
    if (record.snapshot.sessionState !== "idle") {
      throw new Error(
        "Resume requires an idle session; wait for native/user interaction to settle.",
      );
    }
    if (!options.prompt.trim())
      throw new Error("Task prompt must not be blank.");
    const next = { ...record.options, ...options };
    next.description = options.description ?? record.options.description;
    const round = record.execution.round + 1;
    if (!Number.isSafeInteger(round))
      throw new Error("Subagent round limit reached.");
    validateCommand({ ...taskCommand(next), round });
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

  steer(id: string, message: string): void {
    if (!message.trim()) throw new Error("Steering message must not be blank.");
    const record = this.record(id);
    if (record.snapshot.status !== "running") {
      throw new Error("Only a running subagent can be steered.");
    }
    this.send(record, { type: "steer", message });
  }

  stop(id: string): AgentSnapshot {
    const record = this.record(id);
    const execution = record.execution;
    if (execution.finished) return this.snapshot(record);
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
        record.rejectReady?.(new Error("Subagent stopped during startup."));
      } else if (disconnected || !record.socket) {
        if (record.execution.reused && !record.execution.accepted) {
          // An unacknowledged command is not permission to kill native work.
          record.snapshot.status = "disconnected";
        } else {
          void this.terminate(record, "stopped");
        }
      } else {
        this.send(record, { type: "cancel" });
        record.cancelTimer = setTimeout(() => {
          if (record.execution !== execution || execution.finished) return;
          if (execution.reused && !execution.accepted) {
            record.snapshot.status = "disconnected";
            record.snapshot.error =
              "Resume cancellation unconfirmed; worker retained to protect native/user work. Concurrency slot retained.";
            this.changed();
          } else {
            void this.terminate(record, "stopped");
          }
        }, this.options.cancelTimeoutMs ?? 5_000);
      }
    }
    this.changed();
    return this.snapshot(record);
  }

  openView(id: string) {
    const record = this.record(id);
    return this.viewOperation(async () => {
      if (this.disposed) throw new Error("Subagent manager is closed.");
      if (!record.terminal) {
        throw new Error("Subagent terminal is not ready yet.");
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
          ? { terminal: record.terminal, direction: "down", relativeTo }
          : { terminal: record.terminal, direction: "right" },
      );
      record.view = view;
      this.views.set(view.id, record);
      this.changed();
      return view;
    });
  }

  closeView(id: string): Promise<void> {
    const record = this.record(id);
    return this.viewOperation(async () => {
      if (!record.view) return;
      await this.adapter.close_view(record.view);
      this.forgetView(record);
    });
  }

  private forgetView(record: AgentRecord): void {
    if (record.view) this.views.delete(record.view.id);
    record.view = undefined;
    this.changed();
  }

  private async liveView(record: AgentRecord): Promise<ViewHandle | undefined> {
    if (record.view && !(await this.adapter.inspect_view(record.view)).alive) {
      await this.adapter.close_view(record.view);
      this.forgetView(record);
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
    this.closing ??= this.dispose();
    return this.closing;
  }

  private async dispose(): Promise<void> {
    this.disposed = true;
    for (const record of this.records.values()) {
      record.rejectReady?.(new Error("Parent session closed."));
      if (!record.execution.finished) this.finish(record, "stopped");
    }
    for (const socket of this.sockets) socket.destroy();
    await Promise.allSettled([...this.launches]);
    const cleanup = await Promise.allSettled(
      [...this.records.values()].map(async (record) => {
        const viewClosed = await this.closeView(record.snapshot.id).then(
          () => true,
          () => false,
        );
        const terminalClosed = await this.destroyTerminal(record);
        if (!viewClosed || !terminalClosed) {
          throw new Error(`Could not clean up subagent ${record.snapshot.id}.`);
        }
      }),
    );
    await this.endpoint?.catch(() => undefined);
    if (this.server?.listening) {
      await new Promise<void>((resolve) => this.server?.close(() => resolve()));
    }
    if (cleanup.some((result) => result.status === "rejected")) {
      throw new Error("Some subagent terminals could not be cleaned up.");
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
      terminalId: record.terminal?.id,
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
      this.launches.add(launch);
      void launch.finally(() => this.launches.delete(launch));
    }
  }

  private async startResumed(
    record: AgentRecord,
    execution: Execution,
  ): Promise<void> {
    try {
      if (
        !record.terminal ||
        !(await this.adapter.inspect(record.terminal)).alive
      ) {
        throw new Error(
          "Retained Pi terminal is unavailable; no automatic restart.",
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
      this.send(record, taskCommand(record.options));
      this.changed();
    } catch (error) {
      if (record.execution === execution && !execution.finished) {
        this.finish(
          record,
          "error",
          error instanceof Error ? error.message : String(error),
        );
      }
    }
  }

  private async start(record: AgentRecord): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const extensions = await resolveWorkerExtensions(
        this.options.extensionAllowlist ?? SUBAGENT_DEFAULT_EXTENSIONS,
      );
      if (record.execution.finished || this.disposed) return;
      const endpoint = await this.listen();
      if (record.execution.finished || this.disposed) return;
      if (record.snapshot.status === "stopping") {
        this.finish(record, "stopped");
        return;
      }
      const ready = new Promise<void>((resolve, reject) => {
        record.ready = resolve;
        record.rejectReady = reject;
        timer = setTimeout(
          () => reject(new Error("Timed out waiting for the Pi worker.")),
          this.options.startupTimeoutMs ?? 60_000,
        );
      });
      // Attach a rejection handler before awaiting the mux startup command.
      void ready.catch(() => undefined);
      const argv = [
        this.options.executable ?? "pi",
        "--no-extensions",
        "--no-approve",
        "-e",
        this.options.workerPath ??
          fileURLToPath(new URL("./worker.ts", import.meta.url)),
      ];
      for (const extension of extensions) argv.push("-e", extension);
      if (record.options.parentSession) {
        const sessionPath = createClonedSession(
          record.options.parentSession,
          record.options.cwd,
          `subagent-${record.snapshot.id}`,
        );
        record.snapshot.sessionPath = sessionPath;
        // Clone only once. Resume opens no new process and keeps child history.
        record.options.parentSession = undefined;
        argv.push("--session", sessionPath);
      } else {
        argv.push("--session-id", `subagent-${record.snapshot.id}`);
      }
      const agent = record.options.agent;
      const model = agent?.model ?? record.options.model;
      const thinking = agent?.thinking ?? record.options.thinking;
      if (model) argv.push("--model", model);
      if (thinking) argv.push("--thinking", thinking);
      if (agent?.tools !== undefined) {
        if (agent.tools.length) argv.push("--tools", agent.tools.join(","));
        else argv.push("--no-tools");
      }
      if (agent?.disallowedTools?.length) {
        argv.push("--exclude-tools", agent.disallowedTools.join(","));
      }
      if (agent) argv.push("--no-context-files");
      record.terminal = await this.adapter.start({
        agentId: record.snapshot.id,
        cwd: record.options.cwd,
        argv,
        env: {
          PI_KITS_SUBAGENT_WORKER: "1",
          PI_KITS_SUBAGENT_ENDPOINT: endpoint,
          PI_KITS_SUBAGENT_TOKEN: record.token,
          PI_KITS_SUBAGENT_ID: record.snapshot.id,
        },
      });
      if (
        record.execution.finished ||
        this.disposed ||
        this.get(record.snapshot.id).status === "stopping"
      ) {
        await this.terminate(record, "stopped");
        return;
      }
      await ready;
      if (record.execution.finished || this.disposed) return;
      if (this.get(record.snapshot.id).status === "stopping") {
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
      this.send(record, taskCommand(record.options));
    } catch (error) {
      if (error instanceof TerminalStartError) {
        record.terminal = error.terminal;
      }
      await this.terminate(
        record,
        record.snapshot.status === "stopping" ? "stopped" : "error",
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      clearTimeout(timer);
      record.ready = undefined;
      record.rejectReady = undefined;
    }
  }

  private async destroyTerminal(record: AgentRecord): Promise<boolean> {
    const terminal = record.terminal;
    if (!terminal) return true;
    try {
      await this.adapter.destroy(terminal);
      record.terminal = undefined;
      record.snapshot.sessionState = "closed";
      record.snapshot.sessionActivity = undefined;
      this.forgetView(record);
      return true;
    } catch {
      // Retain ownership and the concurrency slot until cleanup can be retried.
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
      if (await this.destroyTerminal(record)) {
        this.finish(record, status, error);
      } else if (!record.execution.finished) {
        record.snapshot.status = "disconnected";
        record.snapshot.error =
          "Worker cleanup failed; concurrency slot retained. Retry stop_subagent.";
        this.changed();
      }
    });
    record.terminating = operation;
    void operation.finally(() => {
      record.terminating = undefined;
    });
    return operation;
  }

  private listen(): Promise<string> {
    this.endpoint ??= new Promise<string>((resolve, reject) => {
      const server = createServer((socket) => this.accept(socket));
      this.server = server;
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (!address || typeof address === "string") {
          reject(new Error("Could not bind the worker control server."));
          return;
        }
        resolve(`127.0.0.1:${address.port}`);
      });
    });
    return this.endpoint;
  }

  private accept(socket: Socket): void {
    if (this.disposed) {
      socket.destroy();
      return;
    }
    this.sockets.add(socket);
    socket.setEncoding("utf8");
    socket.setTimeout(10_000, () => socket.destroy());
    let buffer = "";
    let record: AgentRecord | undefined;
    socket.on("data", (chunk) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > MAX_FRAME_BYTES) {
        socket.destroy();
        return;
      }
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        try {
          const event = JSON.parse(line);
          if (!event || typeof event !== "object") throw new Error("Bad frame");
          if (!record) {
            const candidate = this.records.get(event.id);
            if (
              event.type !== "ready" ||
              !candidate ||
              candidate.execution.finished ||
              candidate.socket ||
              event.token !== candidate.token
            ) {
              throw new Error("Worker authentication failed");
            }
            record = candidate;
            record.socket = socket;
            record.snapshot.sessionState = "idle";
            socket.setTimeout(0);
            if (typeof event.sessionPath === "string") {
              record.snapshot.sessionPath = event.sessionPath;
            }
            this.changed();
            record.ready?.();
          } else {
            this.event(record, event);
          }
        } catch {
          socket.destroy();
          return;
        }
        newline = buffer.indexOf("\n");
      }
    });
    socket.on("error", () => socket.destroy());
    socket.on("close", () => {
      this.sockets.delete(socket);
      if (record?.socket === socket) {
        record.socket = undefined;
        if (record.snapshot.sessionState !== "closed") {
          record.snapshot.sessionState = "disconnected";
          record.snapshot.sessionActivity = undefined;
          this.changed();
        }
        record.rejectReady?.(new Error("Pi worker disconnected."));
        if (
          !record.execution.finished &&
          record.execution.reused &&
          !record.execution.accepted
        ) {
          if (record.execution.dispatched) {
            record.snapshot.status = "disconnected";
            record.snapshot.error =
              "Pi worker disconnected before resume acceptance; concurrency slot retained to protect native/user work.";
            this.changed();
          } else {
            this.finish(
              record,
              "error",
              "Pi worker disconnected before resume dispatch.",
            );
          }
        } else if (
          !record.execution.finished &&
          !record.terminating &&
          !record.ready
        ) {
          void this.terminate(
            record,
            record.snapshot.status === "stopping" ? "stopped" : "error",
            "Pi worker disconnected.",
          );
        }
      }
    });
  }

  private event(record: AgentRecord, event: Record<string, unknown>): void {
    if (event.round !== undefined && event.round !== record.execution.round)
      return;
    if (event.type === "session_state") {
      if (
        typeof event.state !== "string" ||
        !isWorkerSessionState(event.state)
      ) {
        throw new Error("Invalid worker session state");
      }
      if (record.snapshot.sessionState === "closed") return;
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
    if (event.type === "started") record.execution.accepted = true;
    if (event.type === "stats") {
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

  private send(record: AgentRecord, command: object): void {
    if (!record.socket || record.socket.destroyed) {
      throw new Error("Pi worker is not connected.");
    }
    if (record.execution.round > 1)
      command = { ...command, round: record.execution.round };
    validateCommand(command);
    record.socket.write(`${JSON.stringify(command)}\n`);
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

function taskCommand(options: SpawnOptions) {
  return {
    type: "task" as const,
    prompt: options.prompt,
    ...(options.agent
      ? {
          instructions: {
            systemPrompt: options.agent.systemPrompt,
            ...(options.agent.tools !== undefined
              ? {
                  tools: options.agent.tools.filter(
                    (name) => !options.agent?.disallowedTools?.includes(name),
                  ),
                }
              : {}),
          },
        }
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
