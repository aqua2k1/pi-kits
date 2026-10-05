import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { WebSocketServer } from "ws";
import { type CodexSocket, CodexTransport } from "./codex-transport.ts";

class FakeSocket extends EventEmitter implements CodexSocket {
  sent: Array<{ id?: unknown; error?: { code: number; message: string } }> = [];
  terminated = false;
  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }
  close(): void {
    this.emit("close");
  }
  terminate(): void {
    this.terminated = true;
    this.emit("close");
  }
  message(value: unknown): void {
    this.emit("message", JSON.stringify(value));
  }
}
async function fixture(timeoutMs = 1000) {
  const socket = new FakeSocket();
  const notifications: Array<{
    method: string;
    params: Record<string, unknown>;
  }> = [];
  const failures: Error[] = [];
  const connecting = CodexTransport.connect(
    "ws://127.0.0.1:1",
    "secret",
    (method, params) => notifications.push({ method, params }),
    (error) => failures.push(error),
    timeoutMs,
    () => socket,
    timeoutMs,
  );
  socket.emit("open");
  const transport = await connecting;
  return { socket, transport, notifications, failures };
}

test("RPC correlates responses independently of notification/response order", async () => {
  const f = await fixture();
  const a = f.transport.request("a", { one: 1 });
  const b = f.transport.request("b", {});
  f.socket.message({
    method: "turn/started",
    params: { turn: { id: "early" } },
  });
  f.socket.message({ id: f.socket.sent[1].id, result: "b" });
  f.socket.message({ id: f.socket.sent[0].id, result: "a" });
  assert.deepEqual(await Promise.all([a, b]), ["a", "b"]);
  assert.equal(f.notifications[0].method, "turn/started");
  f.transport.close();
});

test("RPC errors reject only their request and release pending slot", async () => {
  const f = await fixture();
  const request = f.transport.request("turn/steer", {});
  f.socket.message({
    id: f.socket.sent[0].id,
    error: { code: -32000, message: "wrong turn" },
  });
  await assert.rejects(request, /wrong turn/);
  const next = f.transport.request("next", {});
  f.socket.message({ id: f.socket.sent[1].id, result: {} });
  await next;
  assert.equal(f.failures.length, 0);
  f.transport.close();
});

test("pending RPCs are bounded to 32 and rejected together on disconnect", async () => {
  const f = await fixture();
  const requests = Array.from({ length: 32 }, () =>
    f.transport.request("wait", {}),
  );
  const settled = Promise.allSettled(requests);
  await assert.rejects(f.transport.request("overflow", {}), /pending limit/);
  assert.equal(f.socket.sent.length, 32);
  f.socket.emit("close");
  assert.ok((await settled).every((entry) => entry.status === "rejected"));
  assert.equal(f.failures.length, 1);
  await assert.rejects(f.transport.request("after", {}), /disconnected/);
});

test("timeout fails ambiguous transport and rejects all other pending requests", async () => {
  const f = await fixture(20);
  const settled = Promise.allSettled([
    f.transport.request("mutating", {}),
    f.transport.request("other", {}),
  ]);
  assert.ok((await settled).every((entry) => entry.status === "rejected"));
  assert.equal(f.socket.terminated, true);
  assert.equal(f.failures.length, 1);
});

test("approval, user-input and unknown server requests always receive error and blocked notification", async () => {
  const f = await fixture();
  for (const method of [
    "item/commandExecution/requestApproval",
    "item/fileChange/requestApproval",
    "item/tool/requestUserInput",
    "item/tool/call",
  ]) {
    f.socket.message({
      id: `server-${method}`,
      method,
      params: { threadId: "thread", turnId: "turn" },
    });
    const response = f.socket.sent.at(-1);
    assert.ok(response?.error);
    assert.equal(response.id, `server-${method}`);
    assert.equal(response.error.code, -32601);
    assert.equal(f.notifications.at(-1)?.method, "runtime/blocked");
  }
  f.transport.close();
});

test("malformed and oversized protocol frames disconnect instead of leaking pending work", async () => {
  for (const frame of [
    "{invalid",
    JSON.stringify(null),
    "x".repeat(1024 * 1024 + 1),
  ]) {
    const f = await fixture();
    const request = f.transport.request("wait", {});
    f.socket.emit("message", frame);
    await assert.rejects(request, /Invalid Codex protocol/);
    assert.equal(f.failures.length, 1);
  }
});

test("connection timeout terminates pre-open socket", async () => {
  const socket = new FakeSocket();
  await assert.rejects(
    CodexTransport.connect(
      "ws://127.0.0.1:1",
      "secret",
      () => {},
      () => {},
      20,
      () => socket,
    ),
    /timed out/,
  );
  assert.equal(socket.terminated, true);
});

test("real loopback WS handshake uses bearer header, not query string; no model call", async () => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  let header: string | undefined;
  let path: string | undefined;
  server.on("connection", (socket, request) => {
    header = request.headers.authorization;
    path = request.url;
    socket.on("message", (raw) => {
      const value = JSON.parse(String(raw));
      socket.send(JSON.stringify({ id: value.id, result: { ok: true } }));
    });
  });
  let transport: CodexTransport | undefined;
  try {
    transport = await CodexTransport.connect(
      `ws://127.0.0.1:${address.port}`,
      "test-token",
      () => {},
      () => {},
    );
    assert.deepEqual(await transport.request("initialize", {}), { ok: true });
    assert.equal(header, "Bearer test-token");
    assert.equal(path, "/");
  } finally {
    transport?.close();
    for (const client of server.clients) client.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("connect deadline does not become request deadline; default RPC timeout is 60 seconds", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const socket = new FakeSocket();
  const failures: Error[] = [];
  const connecting = CodexTransport.connect(
    "ws://127.0.0.1:1",
    "secret",
    () => {},
    (error) => failures.push(error),
    1000,
    () => socket,
  );
  socket.emit("open");
  const transport = await connecting;
  try {
    const read = transport.request("thread/read", {});
    t.mock.timers.tick(59_999);
    assert.equal(failures.length, 0);
    assert.equal(socket.terminated, false);
    socket.message({
      id: socket.sent[0].id,
      result: { thread: { id: "retained" } },
    });
    assert.deepEqual(await read, { thread: { id: "retained" } });
    const pending = transport.request("turn/start", {});
    const rejected = assert.rejects(pending, /RPC timeout: turn\/start/);
    t.mock.timers.tick(60_000);
    await rejected;
    assert.equal(failures.length, 1);
  } finally {
    transport.close();
  }
});

test("native server requests are left for TUI; dynamic managed policy rejects without auto-approval", async () => {
  const socket = new FakeSocket();
  const notifications: string[] = [];
  let managed = false;
  const connecting = CodexTransport.connect(
    "ws://127.0.0.1:1",
    "secret",
    (method) => notifications.push(method),
    () => {},
    1000,
    () => socket,
    60_000,
    () => managed,
  );
  socket.emit("open");
  const transport = await connecting;
  try {
    for (const method of [
      "item/commandExecution/requestApproval",
      "item/tool/requestUserInput",
    ]) {
      socket.message({
        id: `native-${method}`,
        method,
        params: { threadId: "thread" },
      });
    }
    assert.equal(socket.sent.length, 0);
    assert.deepEqual(notifications, []);
    managed = true;
    socket.message({
      id: "managed-input",
      method: "item/tool/requestUserInput",
      params: { threadId: "thread" },
    });
    assert.equal(socket.sent.length, 1);
    assert.deepEqual(socket.sent[0], {
      id: "managed-input",
      error: {
        code: -32601,
        message:
          "Interactive server requests are unsupported by managed Codex runtime",
      },
    });
    assert.deepEqual(notifications, ["runtime/blocked"]);
    managed = false;
    socket.message({
      id: "native-again",
      method: "item/fileChange/requestApproval",
      params: {},
    });
    assert.equal(socket.sent.length, 1);
    assert.deepEqual(notifications, ["runtime/blocked"]);
  } finally {
    transport.close();
  }
});
