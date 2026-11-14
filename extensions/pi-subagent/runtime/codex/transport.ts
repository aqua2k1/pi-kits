import { JsonRpcClient, type RpcClient } from "../transport/json-rpc.ts";
import {
  connectWebSocket,
  createWebSocket,
  type Socket,
} from "../transport/websocket.ts";

export const CODEX_REQUEST_TIMEOUT_MS = 60_000;

export type CodexSocket = Socket;
export type CodexRpc = RpcClient;
export type SocketFactory = (url: string, token: string) => CodexSocket;

/** Codex requires Bearer authentication, never URL query tokens. */
export const createCodexSocket: SocketFactory = (url, token) =>
  createWebSocket(url, {
    headers: { Authorization: `Bearer ${token}` },
    maxPayload: 1024 * 1024,
    perMessageDeflate: false,
    handshakeTimeout: 1000,
  });

/** Codex policy over the shared WebSocket and JSON-RPC mechanisms. */
export class CodexTransport extends JsonRpcClient {
  static connect(
    url: string,
    token: string,
    notification: (method: string, params: Record<string, unknown>) => void,
    disconnected: (error: Error) => void,
    connectTimeoutMs = 1000,
    factory: SocketFactory = createCodexSocket,
    requestTimeoutMs = CODEX_REQUEST_TIMEOUT_MS,
    shouldRejectServerRequest: () => boolean | Promise<boolean> = () => true,
  ): Promise<CodexTransport> {
    return connectWebSocket(
      () => factory(url, token),
      connectTimeoutMs,
      (socket) =>
        new CodexTransport(socket, {
          notification,
          disconnected,
          requestTimeoutMs,
          errorPrefix: "Codex",
          serverRequest(request, respond, isClosed) {
            // Native clients may receive the same request; never race their answer.
            const rejectIfNeeded = (shouldReject: boolean) => {
              if (isClosed() || !shouldReject) return;
              respond({
                id: request.id,
                error: {
                  code: -32601,
                  message:
                    "Interactive server requests are unsupported by managed Codex runtime",
                },
              });
              notification("runtime/blocked", {
                ...request.params,
                requestMethod: request.method,
              });
            };
            const shouldReject = shouldRejectServerRequest();
            if (typeof shouldReject === "boolean") rejectIfNeeded(shouldReject);
            // Unknown native liveness must disconnect, never deny an approval.
            else return shouldReject.then(rejectIfNeeded);
          },
        }),
      "Codex WebSocket",
    );
  }
}
