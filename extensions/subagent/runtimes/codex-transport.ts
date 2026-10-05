import WebSocket from "ws";

export const CODEX_REQUEST_TIMEOUT_MS = 60_000;

/** ws is a runtime dependency of pi-subagent; do not use URL query tokens. */
export interface CodexSocket {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  send(data: string): void;
  close(): void;
  terminate(): void;
}
export type SocketFactory = (url: string, token: string) => CodexSocket;
export const createCodexSocket: SocketFactory = (url, token) => {
  return new WebSocket(url, {
    headers: { Authorization: `Bearer ${token}` },
    maxPayload: 1024 * 1024,
    perMessageDeflate: false,
    handshakeTimeout: 1000,
  }) as CodexSocket;
};

export interface CodexRpc {
  request<T = Record<string, unknown>>(
    method: string,
    params: unknown,
  ): Promise<T>;
  notify(method: string, params?: unknown): void;
  close(): void;
}

/** Bounded JSON-RPC client. Transport failures reject every pending operation. */
export class CodexTransport implements CodexRpc {
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

  private constructor(
    private socket: CodexSocket,
    private notification: (
      method: string,
      params: Record<string, unknown>,
    ) => void,
    private disconnected: (error: Error) => void,
    private requestTimeoutMs: number,
    private shouldRejectServerRequest: () => boolean,
  ) {
    socket.on("message", (data) => this.receive(data));
    socket.on("close", () =>
      this.fail(new Error("Codex WebSocket disconnected")),
    );
    socket.on("error", () =>
      this.fail(new Error("Codex WebSocket transport error")),
    );
  }

  static connect(
    url: string,
    token: string,
    notification: (method: string, params: Record<string, unknown>) => void,
    disconnected: (error: Error) => void,
    connectTimeoutMs = 1000,
    factory: SocketFactory = createCodexSocket,
    requestTimeoutMs = CODEX_REQUEST_TIMEOUT_MS,
    shouldRejectServerRequest: () => boolean = () => true,
  ): Promise<CodexTransport> {
    return new Promise((resolve, reject) => {
      const socket = factory(url, token);
      let settled = false;
      const timer = setTimeout(() => failed(), connectTimeoutMs);
      const failed = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.terminate();
        reject(new Error("Codex WebSocket connection failed or timed out"));
      };
      socket.on("error", failed);
      socket.on("close", failed);
      socket.on("open", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(
          new CodexTransport(
            socket,
            notification,
            disconnected,
            requestTimeoutMs,
            shouldRejectServerRequest,
          ),
        );
      });
    });
  }

  request<T = Record<string, unknown>>(
    method: string,
    params: unknown,
  ): Promise<T> {
    if (this.ended)
      return Promise.reject(new Error("Codex transport disconnected"));
    if (this.pending.size >= 32)
      return Promise.reject(new Error("Codex RPC pending limit exceeded"));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex RPC timeout: ${method}`));
        // Mutating requests may already have executed. Never reuse an ambiguous connection.
        this.fail(new Error(`Codex RPC timeout: ${method}`));
      }, this.requestTimeoutMs);
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      try {
        this.socket.send(JSON.stringify({ id, method, params }));
      } catch {
        this.fail(new Error("Codex RPC write failed"));
      }
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.ended) throw new Error("Codex transport disconnected");
    try {
      this.socket.send(
        JSON.stringify({ method, ...(params === undefined ? {} : { params }) }),
      );
    } catch {
      this.fail(new Error("Codex RPC write failed"));
      throw new Error("Codex RPC write failed");
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
          // Native clients may receive the same request; never race their answer.
          if (!this.shouldRejectServerRequest()) return;
          // Headless adapter cannot safely answer interactive approval/tool/input requests.
          this.socket.send(
            JSON.stringify({
              id: message.id,
              error: {
                code: -32601,
                message:
                  "Interactive server requests are unsupported by managed Codex runtime",
              },
            }),
          );
          this.notification("runtime/blocked", {
            ...message.params,
            requestMethod: message.method,
          });
        } else {
          this.notification(message.method, message.params);
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
            `Codex RPC error: ${String(message.error.message ?? message.error.code).slice(0, 4096)}`,
          ),
        );
      else entry.resolve(message.result);
    } catch {
      this.fail(new Error("Invalid Codex protocol message"));
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
    this.disconnected(error);
  }

  close(): void {
    this.fail(new Error("Codex transport closed"));
  }
}
