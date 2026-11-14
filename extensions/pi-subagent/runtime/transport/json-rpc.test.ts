import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { JsonRpcClient, type JsonRpcOptions } from "./json-rpc.ts";
import type { Socket } from "./websocket.ts";

class FakeSocket extends EventEmitter implements Socket {
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

async function fixture(
  timeoutMs = 1000,
  serverRequest?: JsonRpcOptions["serverRequest"],
) {
  const socket = new FakeSocket();
  const notifications: Array<{
    method: string;
    params: Record<string, unknown>;
  }> = [];
  const failures: Error[] = [];
  const transport = new JsonRpcClient(socket, {
    notification: (method, params) => notifications.push({ method, params }),
    disconnected: (error) => failures.push(error),
    requestTimeoutMs: timeoutMs,
    serverRequest,
  });
  return { socket, transport, notifications, failures };
}

test("server requests use the supplied policy without imposing runtime semantics", async () => {
  const f = await fixture(1000, (request, respond) => {
    respond({ id: request.id, result: { method: request.method } });
  });
  try {
    f.socket.message({ id: "server", method: "custom/request", params: {} });
    assert.deepEqual(f.socket.sent, [
      { id: "server", result: { method: "custom/request" } },
    ]);
    assert.deepEqual(f.notifications, []);
  } finally {
    f.transport.close();
  }
});

test("absent server policy leaves requests unanswered", async () => {
  const f = await fixture();
  f.socket.message({ id: "server", method: "custom/request", params: {} });
  assert.deepEqual(f.socket.sent, []);
  assert.deepEqual(f.notifications, []);
  f.transport.close();
});

test("notification encoding and write failures preserve fail-closed behavior", async () => {
  const f = await fixture();
  f.transport.notify("one");
  f.transport.notify("two", { value: 2 });
  assert.deepEqual(f.socket.sent, [
    { method: "one" },
    { method: "two", params: { value: 2 } },
  ]);
  const pending = f.transport.request("pending", {});
  const rejected = assert.rejects(pending, /write failed/);
  f.socket.send = () => {
    throw new Error("write failed");
  };
  assert.throws(() => f.transport.notify("fail"), /write failed/);
  await rejected;
  assert.equal(f.socket.terminated, true);
  assert.equal(f.failures.length, 1);
  assert.throws(() => f.transport.notify("after"), /disconnected/);
  f.transport.close();
  assert.equal(f.failures.length, 1);
});

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

test("malformed and oversized protocol frames disconnect instead of leaking pending work", async () => {
  for (const frame of [
    "{invalid",
    JSON.stringify(null),
    "x".repeat(1024 * 1024 + 1),
  ]) {
    const f = await fixture();
    const request = f.transport.request("wait", {});
    f.socket.emit("message", frame);
    await assert.rejects(request, /Invalid JSON-RPC protocol/);
    assert.equal(f.failures.length, 1);
  }
});
