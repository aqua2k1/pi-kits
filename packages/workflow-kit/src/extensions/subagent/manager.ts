import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";
import { fileURLToPath } from "node:url";
import {
  type MuxAdapter,
  type TerminalHandle,
  TerminalStartError,
  type ViewHandle,
} from "./mux.ts";

export type AgentStatus =
  | "queued"
  | "starting"
  | "running"
  | "stopping"
  | "disconnected"
  | "completed"
  | "stopped"
  | "error";

export interface AgentSnapshot {
  id: string;
  description: string;
  status: AgentStatus;
  result?: string;
  error?: string;
  activity?: string;
  sessionPath?: string;
  terminalId?: string;
  viewId?: string;
  truncated?: boolean;
}

export interface SpawnOptions {
  prompt: string;
  description: string;
  cwd: string;
  model?: string;
  thinking?: string;
}

interface AgentRecord {
  snapshot: AgentSnapshot;
  options: SpawnOptions;
  token: string;
  terminal?: TerminalHandle;
  view?: ViewHandle;
  socket?: Socket;
  consumed: boolean;
  waiters: number;
  notified: boolean;
  finished: boolean;
  resolve: (snapshot: AgentSnapshot) => void;
  completion: Promise<AgentSnapshot>;
  ready?: () => void;
  rejectReady?: (error: Error) => void;
  cancelTimer?: ReturnType<typeof setTimeout>;
  terminating?: Promise<void>;
  viewQueue: Promise<void>;
}

export interface ManagerOptions {
  maxConcurrent?: number;
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
  private readonly queue: AgentRecord[] = [];
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
    validateCommand({ type: "task", prompt: options.prompt });
    let resolve: AgentRecord["resolve"] = () => undefined;
    const completion = new Promise<AgentSnapshot>((done) => {
      resolve = done;
    });
    const record: AgentRecord = {
      snapshot: {
        id: randomUUID(),
        description: options.description,
        status: "queued",
      },
      options,
      token: randomBytes(32).toString("hex"),
      consumed: false,
      waiters: 0,
      notified: false,
      finished: false,
      viewQueue: Promise.resolve(),
      completion,
      resolve,
    };
    this.records.set(record.snapshot.id, record);
    this.queue.push(record);
    this.pump();
    return this.snapshot(record);
  }

  async result(id: string, wait = false, signal?: AbortSignal) {
    const record = this.record(id);
    if (wait && !record.finished) {
      // Each waiter holds its own claim; one aborted waiter cannot release
      // another caller's claim or cause a duplicate completion notification.
      record.waiters += 1;
      try {
        await waitFor(record.completion, signal);
        record.consumed = true;
      } finally {
        record.waiters -= 1;
        if (record.finished) this.notify(record);
      }
    }
    if (record.finished) record.consumed = true;
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
    if (record.finished) return this.snapshot(record);
    if (record.snapshot.status === "queued") {
      this.finish(record, "stopped");
    } else if (record.snapshot.status !== "stopping") {
      const starting = record.snapshot.status === "starting";
      const disconnected = record.snapshot.status === "disconnected";
      record.snapshot.status = "stopping";
      if (starting) {
        record.rejectReady?.(new Error("Subagent stopped during startup."));
      } else if (disconnected || !record.socket) {
        void this.terminate(record, "stopped");
      } else {
        this.send(record, { type: "cancel" });
        record.cancelTimer = setTimeout(() => {
          void this.terminate(record, "stopped");
        }, this.options.cancelTimeoutMs ?? 5_000);
      }
    }
    return this.snapshot(record);
  }

  openView(id: string, direction: "right" | "down") {
    const record = this.record(id);
    return this.viewOperation(record, async () => {
      if (this.disposed) throw new Error("Subagent manager is closed.");
      if (!record.terminal) {
        throw new Error("Subagent terminal is not ready yet.");
      }
      if (record.view) {
        await this.adapter.focus_view(record.view);
        return record.view;
      }
      const view = await this.adapter.open_view({
        terminal: record.terminal,
        direction,
      });
      record.view = view;
      return view;
    });
  }

  closeView(id: string): Promise<void> {
    const record = this.record(id);
    return this.viewOperation(record, async () => {
      if (!record.view) return;
      await this.adapter.close_view(record.view);
      record.view = undefined;
    });
  }

  private viewOperation<T>(record: AgentRecord, action: () => Promise<T>) {
    const result = record.viewQueue.then(action);
    record.viewQueue = result.then(
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
      if (!record.finished) this.finish(record, "stopped");
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
      const record = this.queue.shift();
      if (!record || record.finished) continue;
      this.active += 1;
      record.snapshot.status = "starting";
      const launch = this.start(record);
      this.launches.add(launch);
      void launch.finally(() => this.launches.delete(launch));
    }
  }

  private async start(record: AgentRecord): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const endpoint = await this.listen();
      if (record.finished || this.disposed) return;
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
        "--no-approve",
        "--session-id",
        `subagent-${record.snapshot.id}`,
        "-e",
        this.options.workerPath ??
          fileURLToPath(new URL("./worker.ts", import.meta.url)),
      ];
      if (record.options.model) argv.push("--model", record.options.model);
      if (record.options.thinking) {
        argv.push("--thinking", record.options.thinking);
      }
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
        record.finished ||
        this.disposed ||
        this.get(record.snapshot.id).status === "stopping"
      ) {
        await this.terminate(record, "stopped");
        return;
      }
      await ready;
      if (record.finished || this.disposed) return;
      if (this.get(record.snapshot.id).status === "stopping") {
        await this.terminate(record, "stopped");
        return;
      }
      record.snapshot.status = "running";
      this.send(record, { type: "task", prompt: record.options.prompt });
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
      record.view = undefined;
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
    const operation = this.viewOperation(record, async () => {
      if (await this.destroyTerminal(record)) {
        this.finish(record, status, error);
      } else if (!record.finished) {
        record.snapshot.status = "disconnected";
        record.snapshot.error =
          "Worker cleanup failed; concurrency slot retained. Retry stop_subagent.";
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
              candidate.finished ||
              candidate.socket ||
              event.token !== candidate.token
            ) {
              throw new Error("Worker authentication failed");
            }
            record = candidate;
            record.socket = socket;
            socket.setTimeout(0);
            if (typeof event.sessionPath === "string") {
              record.snapshot.sessionPath = event.sessionPath;
            }
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
        record.rejectReady?.(new Error("Pi worker disconnected."));
        if (!record.finished && !record.terminating && !record.ready) {
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
    if (record.finished) return;
    if (event.type === "activity" && typeof event.toolName === "string") {
      record.snapshot.activity = event.toolName;
    }
    if (event.type === "completed") {
      if (typeof event.result !== "string") {
        throw new Error("Invalid worker result");
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
    validateCommand(command);
    record.socket.write(`${JSON.stringify(command)}\n`);
  }

  private finish(record: AgentRecord, status: AgentStatus, error?: string) {
    if (record.finished) return;
    const wasActive = record.snapshot.status !== "queued";
    record.finished = true;
    clearTimeout(record.cancelTimer);
    record.snapshot.status = status;
    record.snapshot.error = error;
    if (wasActive) this.active -= 1;
    record.resolve(this.snapshot(record));
    this.notify(record);
    this.pump();
  }

  private notify(record: AgentRecord): void {
    if (
      this.disposed ||
      record.consumed ||
      record.waiters > 0 ||
      record.notified
    ) {
      return;
    }
    record.notified = true;
    try {
      this.options.onComplete?.(this.snapshot(record));
    } catch {
      // A parent notification failure cannot invalidate a completed task.
    }
  }
}

function validateCommand(command: object): void {
  if (Buffer.byteLength(JSON.stringify(command)) > 64 * 1024) {
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
