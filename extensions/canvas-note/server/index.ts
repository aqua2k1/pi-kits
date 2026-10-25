import { randomInt } from "node:crypto";
import { watch } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { WebSocket, WebSocketServer } from "ws";
import { MessageKind } from "../core/contracts.js";
import {
  type Document,
  type DocumentStore,
  documentFingerprint,
} from "../core/model.ts";
import type { Feedback, RenderErrorReport } from "../core/types.ts";
import {
  errorMessage,
  feedbackForDocument,
  parseClientMessage,
  parseReply,
  renderErrorForDocument,
  replyFingerprint,
} from "./protocol.ts";

import { readThemeStyles } from "./theme.ts";

const require = createRequire(import.meta.url);
const assetRoot = fileURLToPath(new URL("../web/", import.meta.url));
const assets = new Map<string, [string, string]>([
  [
    "/core/contracts.js",
    [
      fileURLToPath(new URL("../core/contracts.js", import.meta.url)),
      "text/javascript; charset=utf-8",
    ],
  ],
  ["/", [join(assetRoot, "client.html"), "text/html; charset=utf-8"]],
  [
    "/client.js",
    [join(assetRoot, "client.js"), "text/javascript; charset=utf-8"],
  ],
  [
    "/chart-theme.js",
    [join(assetRoot, "chart-theme.js"), "text/javascript; charset=utf-8"],
  ],
  ["/client.css", [join(assetRoot, "client.css"), "text/css; charset=utf-8"]],
  ["/content.css", [join(assetRoot, "content.css"), "text/css; charset=utf-8"]],
  ["/print.css", [join(assetRoot, "print.css"), "text/css; charset=utf-8"]],
  [
    "/vendor/marked.js",
    [
      join(dirname(require.resolve("marked")), "marked.umd.js"),
      "text/javascript",
    ],
  ],
  [
    "/vendor/purify.js",
    [require.resolve("dompurify/dist/purify.min.js"), "text/javascript"],
  ],
  [
    "/vendor/echarts.js",
    [require.resolve("echarts/dist/echarts.min.js"), "text/javascript"],
  ],
  [
    "/vendor/highlight.js",
    [
      require.resolve("@highlightjs/cdn-assets/highlight.min.js"),
      "text/javascript",
    ],
  ],
  [
    "/vendor/highlight.css",
    [
      require.resolve(
        "@highlightjs/cdn-assets/styles/base16/gruvbox-dark-hard.min.css",
      ),
      "text/css",
    ],
  ],
  [
    "/vendor/highlight-print.css",
    [
      require.resolve("@highlightjs/cdn-assets/styles/atom-one-light.min.css"),
      "text/css",
    ],
  ],
  [
    "/vendor/katex.js",
    [require.resolve("katex/dist/katex.min.js"), "text/javascript"],
  ],
  [
    "/vendor/katex.css",
    [require.resolve("katex/dist/katex.min.css"), "text/css"],
  ],
]);

function resolveAsset(url: string): [string, string] | undefined {
  const path = new URL(url, "http://canvas.local").pathname;
  if (/^\/vendor\/fonts\/[\w.-]+\.(woff2?|ttf)$/.test(path)) {
    const mime = path.endsWith("woff2")
      ? "font/woff2"
      : path.endsWith("woff")
        ? "font/woff"
        : "font/ttf";
    return [
      join(
        dirname(require.resolve("katex/dist/katex.min.css")),
        "fonts",
        basename(path),
      ),
      mime,
    ];
  }
  return assets.get(path);
}

function validatePortRange(
  range: readonly [number, number] = [10_000, 20_000],
): readonly [number, number] {
  const [minimum, maximum] = range;
  if (
    !Number.isInteger(minimum) ||
    !Number.isInteger(maximum) ||
    minimum < 1 ||
    maximum > 65_535 ||
    minimum > maximum
  )
    throw new Error("Invalid Canvas Note port range");
  return range;
}

function portCandidates(
  minimum: number,
  maximum: number,
  start: number,
  fixed: boolean,
): number[] {
  if (fixed) return [start];
  return Array.from(
    { length: maximum - minimum + 1 },
    (_, index) =>
      minimum + ((start - minimum + index) % (maximum - minimum + 1)),
  );
}

function publicUrl(host: string, port: number): string {
  return `http://${host.includes(":") ? `[${host}]` : host}:${port}`;
}

export function resolveCanvasHost(
  configuredHost?: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (configuredHost !== undefined) return configuredHost;
  return env.SSH_CONNECTION || env.SSH_CLIENT || env.SSH_TTY
    ? "0.0.0.0"
    : "localhost";
}

export function resolveCanvasPublicHost(
  listenHost: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const value =
    env.CANVAS_NOTE_PUBLIC_HOST?.trim() ||
    (listenHost === "0.0.0.0" || listenHost === "::"
      ? "localhost"
      : listenHost);
  try {
    if (/[/?#@\\\s]/.test(value)) throw new Error("Expected hostname or IP");
    const authority =
      value.startsWith("[") || !value.includes(":") ? value : `[${value}]`;
    const parsed = new URL(`http://${authority}`);
    if (!parsed.hostname || parsed.port) throw new Error("Unexpected port");
    return parsed.hostname.replace(/^\[|\]$/g, "");
  } catch {
    throw new Error(
      "Invalid CANVAS_NOTE_PUBLIC_HOST: use a hostname or IP without protocol, path or port.",
    );
  }
}

export interface ServerOptions {
  host?: string;
  port?: number;
  portRange?: readonly [number, number];
  store: DocumentStore;
  onReply: (feedback: Feedback) => void | Promise<void>;
  onRenderError?: (error: RenderErrorReport) => void;
  onShutdown?: (reason: "button" | "disconnect") => void | Promise<void>;
  onError?: (error: unknown) => void;
}

export async function startCanvasNoteServer(options: ServerOptions) {
  const { store } = options;
  const listenHost = resolveCanvasHost(options.host);
  const publicHost = resolveCanvasPublicHost(listenHost);
  const [minimum, maximum] = validatePortRange(options.portRange);
  const http = createServer(async (req, res) => {
    try {
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.writeHead(405).end();
        return;
      }
      if (
        new URL(req.url ?? "/", "http://canvas.local").pathname === "/theme.css"
      ) {
        const content = await readThemeStyles();
        res.writeHead(200, {
          "content-type": "text/css; charset=utf-8",
          "cache-control": "no-store",
        });
        res.end(req.method === "HEAD" ? undefined : content);
        return;
      }
      const asset = resolveAsset(req.url ?? "/");
      if (!asset) {
        res.writeHead(404).end();
        return;
      }
      const content = await readFile(asset[0]);
      res.writeHead(200, {
        "content-type": asset[1],
        "cache-control": "no-store",
      });
      res.end(req.method === "HEAD" ? undefined : content);
    } catch {
      res.writeHead(500).end("Canvas Note asset unavailable");
    }
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  let closed = false;
  let closing: Promise<void> | undefined;
  let disconnectTimer: ReturnType<typeof setTimeout> | undefined;
  function requestShutdown(reason: "button" | "disconnect") {
    if (closed) return;
    void Promise.resolve(
      options.onShutdown ? options.onShutdown(reason) : close(),
    ).catch((error) => options.onError?.(error));
  }
  const reported = new Set<string>();
  const requests = new Map<string, string>();
  const pending = new Map<string, Promise<string>>();
  const send = (ws: WebSocket, value: unknown) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(value));
  };
  const broadcast = (value: unknown) => {
    for (const ws of wss.clients) send(ws, value);
  };
  const documentId = basename(dirname(store.path));
  const baselines = new Map<WebSocket, string>();
  let syncing = Promise.resolve();
  function enqueue(publish: () => void) {
    syncing = syncing
      .then(() => {
        if (!closed) publish();
      })
      .catch((error) => options.onError?.(error));
  }
  function sendSnapshot(ws: WebSocket, doc: Document, fingerprint: string) {
    send(ws, { type: MessageKind.Snapshot, documentId, doc });
    baselines.set(ws, fingerprint);
  }
  const unsubscribe = store.subscribe((commit) => {
    enqueue(() => {
      const fingerprint = documentFingerprint(commit.doc);
      for (const ws of wss.clients) {
        const baseline = baselines.get(ws);
        // Connections receive no operations until their queued initial snapshot.
        if (baseline === undefined) continue;
        if (baseline === commit.before) {
          send(ws, {
            type: MessageKind.Operations,
            documentId,
            baseVersion: commit.baseVersion,
            version: commit.doc.version,
            operations: commit.operations,
          });
          baselines.set(ws, fingerprint);
        } else if (baseline !== fingerprint) {
          sendSnapshot(ws, commit.doc, fingerprint);
        }
      }
    });
  });
  // Capture AND enqueue while holding the shared file queue. Enqueuing a read
  // outside it could let a newer snapshot overtake an older commit notification.
  async function capture(ws?: WebSocket) {
    await withFileMutationQueue(store.path, async () => {
      if (closed) return;
      const doc = await store.read();
      if (closed) return;
      enqueue(() => {
        const fingerprint = documentFingerprint(doc);
        if (ws) {
          if (wss.clients.has(ws)) sendSnapshot(ws, doc, fingerprint);
        } else {
          for (const client of wss.clients) {
            if (baselines.has(client) && baselines.get(client) !== fingerprint)
              sendSnapshot(client, doc, fingerprint);
          }
        }
      });
    });
    await syncing;
  }
  const captures = new Set<Promise<void>>();
  function requestCapture(ws?: WebSocket) {
    if (closed) return;
    const task = capture(ws)
      .catch((error) => {
        if (!closed) options.onError?.(error);
      })
      .finally(() => captures.delete(task));
    captures.add(task);
  }
  async function flush() {
    // A file-queue barrier includes every commit already accepted by the store.
    await withFileMutationQueue(store.path, async () => {});
    await syncing;
  }
  const watcher = watch(dirname(store.path), (_event, filename) => {
    if (!filename || String(filename) === basename(store.path))
      requestCapture();
  });
  watcher.on("error", (error) => options.onError?.(error));
  http.on("upgrade", (req, socket, head) => {
    if (req.url !== "/ws" || closed) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) =>
      wss.emit("connection", ws, req),
    );
  });
  wss.on("connection", (ws) => {
    clearTimeout(disconnectTimer);
    ws.on("close", () => {
      baselines.delete(ws);
      if (closed || wss.clients.size > 0) return;
      // Allow reloads and transient reconnects without stopping the server.
      disconnectTimer = setTimeout(() => {
        if (!closed && wss.clients.size === 0) requestShutdown("disconnect");
      }, 1500);
    });
    ws.on("error", (error) => options.onError?.(error));
    requestCapture(ws);
    ws.on("message", (raw) => {
      void (async () => {
        let requestId: string | undefined;
        try {
          if (closed) return;
          const msg = parseClientMessage(raw.toString());
          requestId =
            typeof msg.requestId === "string" ? msg.requestId : undefined;
          if (msg.type === MessageKind.Resync) {
            requestCapture(ws);
            return;
          }
          if (msg.type === MessageKind.Shutdown) {
            requestShutdown("button");
            return;
          }
          if (msg.type === MessageKind.RenderError) {
            const doc = await store.read();
            const report = renderErrorForDocument(msg, doc);
            if (!closed && report && !reported.has(report.key)) {
              if (reported.size >= 100) return;
              reported.add(report.key);
              options.onRenderError?.(report.error);
            }
            return;
          }
          const reply = parseReply(msg);
          requestId = reply.requestId;
          const fingerprint = replyFingerprint(reply);
          if (requests.has(requestId)) {
            if (requests.get(requestId) !== fingerprint)
              throw new Error("requestId already used");
            send(ws, { type: MessageKind.Ack, requestId });
            return;
          }
          const existing = pending.get(requestId);
          if (existing) {
            if ((await existing) !== fingerprint)
              throw new Error("requestId already used");
            send(ws, { type: MessageKind.Ack, requestId });
            return;
          }
          const operation = withFileMutationQueue(store.path, async () => {
            const doc = await store.read();
            const feedback = feedbackForDocument(reply, doc);
            if (closed) throw new Error("Canvas Note server closed");
            await options.onReply(feedback);
            requests.set(requestId as string, fingerprint);
            if (requests.size > 500)
              requests.delete(requests.keys().next().value as string);
            return fingerprint;
          });
          pending.set(requestId, operation);
          try {
            await operation;
            send(ws, { type: MessageKind.Ack, requestId });
          } finally {
            pending.delete(requestId);
          }
        } catch (error) {
          send(ws, {
            type: MessageKind.Error,
            requestId,
            message: errorMessage(error),
          });
        }
      })();
    });
  });
  async function close() {
    if (closing) return closing;
    closed = true;
    clearTimeout(disconnectTimer);
    watcher.close();
    unsubscribe();
    broadcast({ type: MessageKind.ServerClosing });
    closing = (async () => {
      await Promise.allSettled([...pending.values(), ...captures]);
      for (const ws of wss.clients) {
        ws.close(1001, "Canvas Note stopped");
        ws.terminate();
      }
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve, reject) =>
        http.close((error) => (error ? reject(error) : resolve())),
      );
      await syncing;
    })();
    return closing;
  }
  try {
    const start = options.port ?? randomInt(minimum, maximum + 1);
    const ports = portCandidates(
      minimum,
      maximum,
      start,
      options.port !== undefined,
    );
    for (const [attempt, port] of ports.entries()) {
      try {
        await new Promise<void>((resolve, reject) => {
          const listening = () => {
            http.off("error", failed);
            resolve();
          };
          const failed = (error: Error) => {
            http.off("listening", listening);
            reject(error);
          };
          http.once("error", failed);
          http.once("listening", listening);
          // Keep localhost URLs reachable when HTTP clients prefer IPv4 over DNS's IPv6-first order.
          http.listen(
            port,
            listenHost === "localhost" ? "127.0.0.1" : listenHost,
          );
        });
        break;
      } catch (error) {
        if (
          options.port !== undefined ||
          (error as NodeJS.ErrnoException).code !== "EADDRINUSE"
        )
          throw error;
        if (attempt === ports.length - 1)
          throw new Error(
            `No available Canvas Note port in ${minimum}-${maximum}`,
          );
      }
    }
  } catch (error) {
    closed = true;
    watcher.close();
    unsubscribe();
    wss.close();
    throw error;
  }
  http.on("error", (error) => options.onError?.(error));
  const address = http.address();
  if (!address || typeof address === "string")
    throw new Error("Canvas Note address unavailable");
  const url = publicUrl(publicHost, address.port);
  return {
    url,
    close,
    flush,
    get clientCount() {
      return wss.clients.size;
    },
  };
}
export type CanvasNoteServer = Awaited<
  ReturnType<typeof startCanvasNoteServer>
>;
