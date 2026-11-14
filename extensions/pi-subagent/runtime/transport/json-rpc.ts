import type { Socket } from "./websocket.ts";

export interface RpcClient {
  request<T = Record<string, unknown>>(
    method: string,
    params: unknown,
  ): Promise<T>;
  notify(method: string, params?: unknown): void;
  close(): void;
}

export interface ServerRequest {
  id: unknown;
  method: string;
  params: Record<string, unknown>;
}

export interface JsonRpcOptions {
  notification(method: string, params: Record<string, unknown>): void;
  disconnected(error: Error): void;
  /** No handler leaves requests unanswered for another native client. */
  serverRequest?(
    request: ServerRequest,
    respond: (response: Record<string, unknown>) => void,
    isClosed: () => boolean,
  ): void | Promise<void>;
  requestTimeoutMs: number;
  errorPrefix?: string;
}

/** Bounded JSON-RPC client. Transport failures reject every pending operation. */
export class JsonRpcClient implements RpcClient {
  private nextId = 0;
  private ended = false;
  private pending = new Map<
    number,
    {
      resolve(value: unknown): void;
      reject(error: Error): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private readonly prefix: string;

  constructor(
    private socket: Socket,
    private options: JsonRpcOptions,
  ) {
    this.prefix = options.errorPrefix ?? "JSON-RPC";
    socket.on("message", (data) => this.receive(data));
    socket.on("close", () =>
      this.fail(new Error(`${this.prefix} WebSocket disconnected`)),
    );
    socket.on("error", () =>
      this.fail(new Error(`${this.prefix} WebSocket transport error`)),
    );
  }

  request<T = Record<string, unknown>>(
    method: string,
    params: unknown,
  ): Promise<T> {
    if (this.ended)
      return Promise.reject(new Error(`${this.prefix} transport disconnected`));
    if (this.pending.size >= 32)
      return Promise.reject(
        new Error(`${this.prefix} RPC pending limit exceeded`),
      );
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${this.prefix} RPC timeout: ${method}`));
        // Mutating requests may already have executed. Never reuse an ambiguous connection.
        this.fail(new Error(`${this.prefix} RPC timeout: ${method}`));
      }, this.options.requestTimeoutMs);
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      try {
        this.socket.send(JSON.stringify({ id, method, params }));
      } catch {
        this.fail(new Error(`${this.prefix} RPC write failed`));
      }
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.ended) throw new Error(`${this.prefix} transport disconnected`);
    try {
      this.socket.send(
        JSON.stringify({ method, ...(params === undefined ? {} : { params }) }),
      );
    } catch {
      this.fail(new Error(`${this.prefix} RPC write failed`));
      throw new Error(`${this.prefix} RPC write failed`);
    }
  }

  private receive(data: unknown): void {
    if (this.ended) return;
    try {
      const raw = String(data);
      if (Buffer.byteLength(raw) > 1024 * 1024)
        throw new Error("oversized frame");
      const message = JSON.parse(raw);
      if (!message || typeof message !== "object" || Array.isArray(message))
        throw new Error("invalid envelope");
      if (typeof message.method === "string") {
        if (message.id !== undefined) {
          const handling = this.options.serverRequest?.(
            message,
            (response) => {
              if (!this.ended) this.socket.send(JSON.stringify(response));
            },
            () => this.ended,
          );
          if (handling)
            void handling.catch(() => {
              this.fail(
                new Error(`${this.prefix} server request handling failed`),
              );
            });
        } else {
          this.options.notification(message.method, message.params);
        }
        return;
      }
      const entry = this.pending.get(message.id);
      if (!entry) return; // Late or foreign response.
      if (!("result" in message) && !("error" in message))
        throw new Error("invalid response");
      clearTimeout(entry.timer);
      this.pending.delete(message.id);
      if (message.error)
        entry.reject(
          new Error(
            `${this.prefix} RPC error: ${String(message.error.message ?? message.error.code).slice(0, 4096)}`,
          ),
        );
      else entry.resolve(message.result);
    } catch {
      this.fail(new Error(`Invalid ${this.prefix} protocol message`));
    }
  }

  private fail(error: Error): void {
    if (this.ended) return;
    this.ended = true;
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
    this.socket.terminate();
    this.options.disconnected(error);
  }

  close(): void {
    this.fail(new Error(`${this.prefix} transport closed`));
  }
}
