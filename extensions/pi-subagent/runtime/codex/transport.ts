import WebSocket from "ws";

export const CODEX_REQUEST_TIMEOUT_MS = 60_000;
const MAX_FRAME_BYTES = 1024 * 1024;
const MAX_PENDING_REQUESTS = 32;

export interface CodexSocket {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  send(data: string): void;
  close(): void;
  terminate(): void;
}

export interface CodexRpc {
  request<T = Record<string, unknown>>(
    method: string,
    params: unknown,
  ): Promise<T>;
  notify(method: string, params?: unknown): void;
  close(): void;
}

export type SocketFactory = (url: string, token: string) => CodexSocket;

export interface CodexConnectOptions {
  url: string;
  token: string;
  notification(method: string, params: Record<string, unknown>): void;
  disconnected(error: Error): void;
  connectTimeoutMs?: number;
  requestTimeoutMs?: number;
  factory?: SocketFactory;
  /** Return false to leave server requests unanswered for a native client. */
  shouldRejectServerRequest?: () => boolean | Promise<boolean>;
}

/** Codex requires Bearer authentication, never URL query tokens. */
export const createCodexSocket: SocketFactory = (url, token) =>
  new WebSocket(url, {
    headers: { Authorization: `Bearer ${token}` },
    maxPayload: MAX_FRAME_BYTES,
    perMessageDeflate: false,
    handshakeTimeout: 1000,
  }) as CodexSocket;

type ParsedFrame =
  | {
      kind: "server_request";
      id: unknown;
      method: string;
      params: Record<string, unknown>;
    }
  | { kind: "notification"; method: string; params: Record<string, unknown> }
  | {
      kind: "response";
      id: unknown;
      result?: unknown;
      error?: { message?: unknown; code?: unknown };
    };

function parseProtocolFrame(data: unknown): ParsedFrame {
  const raw = String(data);
  if (Buffer.byteLength(raw) > MAX_FRAME_BYTES) {
    throw new Error("oversized frame");
  }
  const message = JSON.parse(raw);
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    throw new Error("invalid envelope");
  }
  if (typeof message.method === "string") {
    if (message.id !== undefined) {
      return {
        kind: "server_request",
        id: message.id,
        method: message.method,
        params: message.params ?? {},
      };
    }
    return {
      kind: "notification",
      method: message.method,
      params: message.params,
    };
  }
  if (!("result" in message) && !("error" in message)) {
    throw new Error("invalid response");
  }
  return {
    kind: "response",
    id: message.id,
    result: message.result,
    error: message.error,
  };
}

function attachCodexTransport(
  socket: CodexSocket,
  notification: CodexConnectOptions["notification"],
  disconnected: CodexConnectOptions["disconnected"],
  requestTimeoutMs: number,
  shouldRejectServerRequest: () => boolean | Promise<boolean>,
): CodexRpc {
  let nextId = 0;
  let ended = false;
  const pending = new Map<
    number,
    {
      resolve(value: unknown): void;
      reject(error: Error): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  const fail = (error: Error): void => {
    if (ended) return;
    ended = true;
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    pending.clear();
    socket.terminate();
    disconnected(error);
  };

  const handleServerRequest = (
    id: unknown,
    method: string,
    params: Record<string, unknown>,
  ): void => {
    const rejectIfNeeded = (shouldReject: boolean) => {
      if (ended || !shouldReject) return;
      socket.send(
        JSON.stringify({
          id,
          error: {
            code: -32601,
            message:
              "Interactive server requests are unsupported by managed Codex runtime",
          },
        }),
      );
      notification("runtime/blocked", { ...params, requestMethod: method });
    };
    const decision = shouldRejectServerRequest();
    if (typeof decision === "boolean") {
      rejectIfNeeded(decision);
      return;
    }
    // Unknown native liveness must disconnect, never deny an approval.
    void decision.then(rejectIfNeeded).catch(() => {
      fail(new Error("Codex server request handling failed"));
    });
  };

  socket.on("message", (data) => {
    if (ended) return;
    try {
      const frame = parseProtocolFrame(data);
      if (frame.kind === "server_request") {
        handleServerRequest(frame.id, frame.method, frame.params);
        return;
      }
      if (frame.kind === "notification") {
        notification(frame.method, frame.params);
        return;
      }
      const entry = pending.get(frame.id as number);
      if (!entry) return;
      clearTimeout(entry.timer);
      pending.delete(frame.id as number);
      if (frame.error) {
        entry.reject(
          new Error(
            `Codex RPC error: ${String(frame.error.message ?? frame.error.code).slice(0, 4096)}`,
          ),
        );
      } else {
        entry.resolve(frame.result);
      }
    } catch {
      fail(new Error("Invalid Codex protocol message"));
    }
  });
  socket.on("close", () => fail(new Error("Codex WebSocket disconnected")));
  socket.on("error", () => fail(new Error("Codex WebSocket transport error")));

  return {
    request<T = Record<string, unknown>>(
      method: string,
      params: unknown,
    ): Promise<T> {
      if (ended) {
        return Promise.reject(new Error("Codex transport disconnected"));
      }
      if (pending.size >= MAX_PENDING_REQUESTS) {
        return Promise.reject(new Error("Codex RPC pending limit exceeded"));
      }
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          const error = new Error(`Codex RPC timeout: ${method}`);
          reject(error);
          // Mutating requests may already have executed; never reuse an ambiguous socket.
          fail(error);
        }, requestTimeoutMs);
        pending.set(id, {
          resolve: (value) => resolve(value as T),
          reject,
          timer,
        });
        try {
          socket.send(JSON.stringify({ id, method, params }));
        } catch {
          fail(new Error("Codex RPC write failed"));
        }
      });
    },
    notify(method: string, params?: unknown): void {
      if (ended) throw new Error("Codex transport disconnected");
      try {
        socket.send(
          JSON.stringify({
            method,
            ...(params === undefined ? {} : { params }),
          }),
        );
      } catch {
        fail(new Error("Codex RPC write failed"));
        throw new Error("Codex RPC write failed");
      }
    },
    close(): void {
      fail(new Error("Codex transport closed"));
    },
  };
}

/** Bounded WebSocket JSON-RPC client with Codex's headless approval policy. */
export function connectCodexTransport(
  options: CodexConnectOptions,
): Promise<CodexRpc> {
  const {
    url,
    token,
    notification,
    disconnected,
    connectTimeoutMs = 1000,
    requestTimeoutMs = CODEX_REQUEST_TIMEOUT_MS,
    factory = createCodexSocket,
    shouldRejectServerRequest = () => true,
  } = options;
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
      try {
        // Install listeners synchronously on open so initial events are not lost.
        resolve(
          attachCodexTransport(
            socket,
            notification,
            disconnected,
            requestTimeoutMs,
            shouldRejectServerRequest,
          ),
        );
      } catch (error) {
        socket.terminate();
        reject(error);
      }
    });
  });
}
