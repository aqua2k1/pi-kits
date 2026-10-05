import { randomBytes } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";
import { fileURLToPath } from "node:url";
import { SUBAGENT_DEFAULT_EXTENSIONS } from "@pi-kits/config";
import { createClonedSession } from "../clone.ts";
import { resolveWorkerExtensions } from "../extensions.ts";
import { type TerminalHandle, TerminalStartError } from "../mux.ts";
import { MAX_COMMAND_BYTES } from "../protocol.ts";
import type {
  AgentRuntime,
  RuntimeCapabilities,
  RuntimeCommand,
  RuntimeEvent,
  RuntimeHost,
  RuntimeOptions,
  RuntimeSession,
} from "../runtime.ts";

const MAX_FRAME_BYTES = 1_048_576;
const capabilities: RuntimeCapabilities = {
  nativeClone: true,
  steer: true,
  retainedSession: true,
  concurrentNativeInput: true,
};

/** Pi owns its worker process and authenticated, one-shot TCP transport. */
export class PiRuntime implements AgentRuntime {
  readonly id = "pi";
  readonly displayName = "Pi";
  readonly capabilities = capabilities;

  validate(_options: RuntimeOptions): void {}

  create(options: RuntimeOptions, host: RuntimeHost): RuntimeSession {
    return new PiSession(options, host);
  }
}

class PiSession implements RuntimeSession {
  readonly capabilities = capabilities;
  terminal: TerminalHandle | undefined;
  private readonly token = randomBytes(32).toString("hex");
  private readonly sockets = new Set<Socket>();
  private socket?: Socket;
  private server?: Server;
  private authenticated = false;
  private closed = false;
  private starting?: Promise<void>;
  private closing?: Promise<void>;
  private ready?: () => void;
  private rejectReady?: (error: Error) => void;

  constructor(
    private readonly options: RuntimeOptions,
    private readonly host: RuntimeHost,
  ) {}

  get connected(): boolean {
    return Boolean(this.socket && !this.socket.destroyed && !this.closed);
  }

  start(): Promise<void> {
    this.starting ??= this.launch();
    return this.starting;
  }

  private async launch(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (this.closed) throw new Error("Pi worker is closed.");
      const extensions = await resolveWorkerExtensions(
        this.options.extensionAllowlist ?? SUBAGENT_DEFAULT_EXTENSIONS,
      );
      if (this.closed) throw new Error("Pi worker is closed.");
      const endpoint = await this.listen();
      if (this.closed) throw new Error("Pi worker is closed.");
      const ready = new Promise<void>((resolve, reject) => {
        this.ready = resolve;
        this.rejectReady = reject;
        timer = setTimeout(
          () => reject(new Error("Timed out waiting for the Pi worker.")),
          this.options.startupTimeoutMs ?? 60_000,
        );
      });
      // A terminal startup can outlive cancellation or the ready timeout.
      void ready.catch(() => undefined);
      const argv = [
        this.options.executable ?? "pi",
        "--no-extensions",
        "--no-approve",
        "-e",
        this.options.workerPath ??
          fileURLToPath(new URL("../worker.ts", import.meta.url)),
      ];
      for (const extension of extensions) argv.push("-e", extension);
      if (this.options.parentSession) {
        const sessionPath = createClonedSession(
          this.options.parentSession,
          this.options.cwd,
          `subagent-${this.options.id}`,
        );
        this.host.emit({ type: "session_state", state: "idle", sessionPath });
        argv.push("--session", sessionPath);
      } else {
        argv.push("--session-id", `subagent-${this.options.id}`);
      }
      const agent = this.options.agent;
      const model = agent?.model ?? this.options.model;
      const thinking = agent?.thinking ?? this.options.thinking;
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
      this.terminal = await this.host.mux.start({
        agentId: this.options.id,
        cwd: this.options.cwd,
        argv,
        env: {
          PI_KITS_SUBAGENT_WORKER: "1",
          PI_KITS_SUBAGENT_ENDPOINT: endpoint,
          PI_KITS_SUBAGENT_TOKEN: this.token,
          PI_KITS_SUBAGENT_ID: this.options.id,
        },
      });
      if (this.closed) throw new Error("Pi worker is closed.");
      await ready;
      if (!this.connected) throw new Error("Pi worker disconnected.");
    } catch (error) {
      if (error instanceof TerminalStartError) this.terminal = error.terminal;
      throw error;
    } finally {
      clearTimeout(timer);
      this.ready = undefined;
      this.rejectReady = undefined;
    }
  }

  send(command: RuntimeCommand): void {
    if (!this.connected) throw new Error("Pi worker is not connected.");
    const frame = JSON.stringify(command);
    if (Buffer.byteLength(frame) > MAX_COMMAND_BYTES) {
      throw new Error("Subagent command exceeds the 64 KiB protocol limit.");
    }
    this.socket?.write(`${frame}\n`);
  }

  async inspect(): Promise<boolean> {
    return Boolean(
      this.connected &&
        this.terminal &&
        (await this.host.mux.inspect(this.terminal)).alive,
    );
  }

  async attachment(): Promise<TerminalHandle> {
    if (!this.terminal || this.closed) {
      throw new Error("Subagent terminal is not ready yet.");
    }
    return this.terminal;
  }

  close(): Promise<void> {
    this.closed = true;
    this.rejectReady?.(new Error("Pi worker closed during startup."));
    if (this.closing) return this.closing;
    const operation = this.cleanup();
    this.closing = operation;
    void operation.then(
      () => {
        this.closing = undefined;
      },
      () => {
        this.closing = undefined;
      },
    );
    return operation;
  }

  private async cleanup(): Promise<void> {
    await this.starting?.catch(() => undefined);
    try {
      if (this.terminal) {
        await this.host.mux.destroy(this.terminal);
        this.terminal = undefined;
      }
    } finally {
      // Keep terminal ownership on destroy failure so close can be retried.
      this.socket = undefined;
      for (const socket of this.sockets) socket.destroy();
      if (this.server?.listening) {
        await new Promise<void>((resolve) =>
          this.server?.close(() => resolve()),
        );
      }
    }
  }

  private listen(): Promise<string> {
    return new Promise<string>((resolve, reject) => {
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
  }

  private accept(socket: Socket): void {
    if (this.closed) {
      socket.destroy();
      return;
    }
    this.sockets.add(socket);
    socket.setEncoding("utf8");
    socket.setTimeout(10_000, () => socket.destroy());
    let buffer = "";
    let authenticated = false;
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
          const event = JSON.parse(line) as RuntimeEvent;
          if (!event || typeof event !== "object") throw new Error("Bad frame");
          if (!authenticated) {
            if (
              event.type !== "ready" ||
              event.id !== this.options.id ||
              event.token !== this.token ||
              this.authenticated ||
              this.closed
            ) {
              throw new Error("Worker authentication failed");
            }
            authenticated = true;
            this.authenticated = true;
            this.socket = socket;
            socket.setTimeout(0);
            this.host.emit({
              type: "session_state",
              state: "idle",
              model: event.model,
              modelName: event.modelName,
              sessionPath: event.sessionPath,
              runtimeSessionId: `subagent-${this.options.id}`,
            });
            this.ready?.();
          } else {
            this.host.emit(event);
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
      if (this.socket !== socket) return;
      this.socket = undefined;
      this.rejectReady?.(new Error("Pi worker disconnected."));
      if (!this.closed) {
        this.host.emit({
          type: "disconnected",
          error: "Pi worker disconnected.",
        });
      }
    });
  }
}
