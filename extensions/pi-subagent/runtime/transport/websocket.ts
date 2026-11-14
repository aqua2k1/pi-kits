import WebSocket, { type ClientOptions } from "ws";

export interface Socket {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  send(data: string): void;
  close(): void;
  terminate(): void;
}

export function createWebSocket(
  url: string,
  options: ClientOptions = {},
): Socket {
  return new WebSocket(url, options) as Socket;
}

/** Establishes a socket without owning authentication or application messages. */
export function connectWebSocket<T>(
  factory: () => Socket,
  timeoutMs: number,
  connected: (socket: Socket) => T,
  errorPrefix = "WebSocket",
): Promise<T> {
  return new Promise((resolve, reject) => {
    const socket = factory();
    let settled = false;
    const timer = setTimeout(() => failed(), timeoutMs);
    const failed = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.terminate();
      reject(new Error(`${errorPrefix} connection failed or timed out`));
    };
    socket.on("error", failed);
    socket.on("close", failed);
    socket.on("open", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        resolve(connected(socket));
      } catch (error) {
        socket.terminate();
        reject(error);
      }
    });
  });
}
