import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer as createPortBlocker } from "node:net";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { WebSocket } from "ws";
import { DocumentStore } from "../core/model.ts";
import type { Feedback } from "../core/types.ts";
import {
  resolveCanvasHost,
  resolveCanvasPublicHost,
  startCanvasNoteServer,
} from "../server/index.ts";

test("host selection detects SSH and explicit configuration always wins", () => {
  assert.equal(resolveCanvasHost(undefined, {}), "localhost");
  for (const name of ["SSH_CONNECTION", "SSH_CLIENT", "SSH_TTY"]) {
    const env = { [name]: "ssh-session" };
    assert.equal(resolveCanvasHost(undefined, env), "0.0.0.0");
    assert.equal(resolveCanvasHost("localhost", env), "localhost");
    assert.equal(resolveCanvasHost("127.0.0.1", env), "127.0.0.1");
    assert.equal(resolveCanvasHost("192.0.2.10", env), "192.0.2.10");
  }
  assert.equal(resolveCanvasHost("0.0.0.0", {}), "0.0.0.0");
});

test("public URL host comes only from the environment and validates host syntax", () => {
  assert.equal(resolveCanvasPublicHost("0.0.0.0", {}), "localhost");
  assert.equal(resolveCanvasPublicHost("127.0.0.1", {}), "127.0.0.1");
  for (const [value, expected] of [
    ["192.0.2.10", "192.0.2.10"],
    ["notes.example.com", "notes.example.com"],
    ["::1", "::1"],
    ["[::1]", "::1"],
  ]) {
    assert.equal(
      resolveCanvasPublicHost("0.0.0.0", { CANVAS_NOTE_PUBLIC_HOST: value }),
      expected,
    );
  }
  for (const value of [
    "http://example.com",
    "example.com:8080",
    "host/path",
    "user@host",
    "a\\nb",
    "[invalid]",
  ]) {
    assert.throws(
      () =>
        resolveCanvasPublicHost("0.0.0.0", { CANVAS_NOTE_PUBLIC_HOST: value }),
      /CANVAS_NOTE_PUBLIC_HOST/,
    );
  }
});

function inbox(ws: WebSocket) {
  const messages: Record<string, unknown>[] = [];
  const waiters: (() => void)[] = [];
  ws.on("message", (raw) => {
    messages.push(JSON.parse(raw.toString()));
    for (const wake of waiters.splice(0)) wake();
  });
  return async function next(
    predicate: (msg: Record<string, unknown>) => boolean,
  ) {
    const timeout = AbortSignal.timeout(5000);
    while (true) {
      const index = messages.findIndex(predicate);
      if (index >= 0) return messages.splice(index, 1)[0];
      await new Promise<void>((resolve, reject) => {
        if (timeout.aborted) {
          reject(new Error("message timeout"));
          return;
        }
        const abort = () => reject(new Error("message timeout"));
        timeout.addEventListener("abort", abort, { once: true });
        waiters.push(() => {
          timeout.removeEventListener("abort", abort);
          resolve();
        });
      });
    }
  };
}

test("real HTTP, WebSocket snapshots, atomic rename watch, reply acknowledgment and restart", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "canvas-note-server-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new DocumentStore(join(dir, "doc.json"));
  const inserted = await store.insert({
    blocks: [{ type: "text", spec: { md: "**Hello**" } }],
  });
  const feedback: Feedback[] = [];
  const errors: unknown[] = [];
  const options = {
    host: "127.0.0.1",
    port: 0,
    store,
    onReply: (value: Feedback) => {
      feedback.push(value);
    },
    onError: (error: unknown) => errors.push(error),
  };
  const server = await startCanvasNoteServer(options);
  t.after(() => server.close());
  const res = await fetch(server.url);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Canvas Note/);
  for (const path of [
    "/client.js",
    "/client.css",
    "/vendor/marked.js",
    "/vendor/purify.js",
    "/vendor/echarts.js",
    "/vendor/katex.js",
    "/vendor/katex.css",
    "/vendor/fonts/KaTeX_Main-Regular.woff2",
  ])
    assert.equal((await fetch(server.url + path)).status, 200, path);
  assert.equal((await fetch(`${server.url}/missing`)).status, 404);
  const ws = new WebSocket(`${server.url.replace("http:", "ws:")}/ws`);
  const next = inbox(ws);
  t.after(() => ws.terminate());
  const initialSnapshot = await next((msg) => msg.type === "snapshot");
  assert.equal(initialSnapshot.documentId, basename(dir));
  await store.update({
    blocks: [{ blockId: inserted.blockIds[0], spec: { md: "fixed" } }],
  });
  const snapshot = await next(
    (msg) =>
      msg.type === "snapshot" && (msg.doc as { version: number }).version === 2,
  );
  assert.equal(snapshot.documentId, basename(dir));
  assert.equal(
    (snapshot.doc as { pages: { blocks: { spec: { md: string } }[] }[] })
      .pages[0].blocks[0].spec.md,
    "fixed",
  );
  const reply = {
    type: "reply",
    requestId: "reply-1",
    version: 2,
    blockIds: inserted.blockIds,
    reply: "请解释",
  };
  ws.send(JSON.stringify(reply));
  await next((msg) => msg.type === "ack");
  ws.send(JSON.stringify(reply));
  await next((msg) => msg.type === "ack");
  assert.equal(feedback.length, 1);
  assert.equal(feedback[0].version, 2);
  assert.equal(feedback[0].reply, "请解释");
  ws.send(JSON.stringify({ ...reply, requestId: "stale", version: 1 }));
  assert.match(
    String((await next((msg) => msg.type === "error")).message),
    /内容已更新/,
  );
  ws.send("bad json");
  await next((msg) => msg.type === "error");
  const disconnected = once(ws, "close");
  await server.close();
  await disconnected;
  await server.close();
  const restarted = await startCanvasNoteServer({
    ...options,
    port: Number(new URL(server.url).port),
  });
  const reconnected = new WebSocket(
    `${restarted.url.replace("http:", "ws:")}/ws`,
  );
  t.after(() => reconnected.terminate());
  const restoredSnapshot = await inbox(reconnected)(
    (msg) => msg.type === "snapshot",
  );
  assert.equal(restoredSnapshot.documentId, basename(dir));
  await restarted.close();
  assert.deepEqual(errors, []);
});

test("shutdown drains queued replies without invoking a stale runtime callback", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "canvas-note-close-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new DocumentStore(join(dir, "doc.json"));
  const { blockIds } = await store.insert({
    blocks: [{ type: "text", spec: { md: "test" } }],
  });
  let delivered = 0;
  const server = await startCanvasNoteServer({
    host: "127.0.0.1",
    port: 0,
    store,
    onReply: () => {
      delivered++;
    },
  });
  t.after(() => server.close());
  const ws = new WebSocket(`${server.url.replace("http:", "ws:")}/ws`);
  t.after(() => ws.terminate());
  const next = inbox(ws);
  await next((msg) => msg.type === "snapshot");
  let release!: () => void;
  let acquired!: () => void;
  const ready = new Promise<void>((resolve) => {
    acquired = resolve;
  });
  const lock = withFileMutationQueue(store.path, async () => {
    acquired();
    await new Promise<void>((resolve) => {
      release = resolve;
    });
  });
  await ready;
  ws.send(
    JSON.stringify({
      type: "reply",
      requestId: "queued",
      version: 1,
      blockIds,
      reply: "late reply",
    }),
  );
  ws.send(JSON.stringify({ type: "invalid", requestId: "probe" }));
  await next((msg) => msg.type === "error" && msg.requestId === "probe");
  const stopping = server.close();
  release();
  await lock;
  await stopping;
  assert.equal(delivered, 0);
});

test("port ranges stay within bounds and report exhaustion without leaking resources", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "canvas-note-ports-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new DocumentStore(join(dir, "doc.json"));
  await store.newPage({ title: "Ports" });
  const blocker = createPortBlocker();
  await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
  t.after(() => blocker.close());
  const address = blocker.address();
  assert.ok(address && typeof address !== "string");
  const options = { host: "127.0.0.1", store, onReply: () => {} };
  await assert.rejects(
    startCanvasNoteServer({
      ...options,
      portRange: [address.port, address.port],
    }),
    /No available Canvas Note port/,
  );
  await new Promise<void>((resolve) => blocker.close(() => resolve()));
  const freed = await startCanvasNoteServer({
    ...options,
    portRange: [address.port, address.port],
  });
  t.after(() => freed.close());
  assert.equal(Number(new URL(freed.url).port), address.port);
  await freed.close();
  const defaults = await startCanvasNoteServer(options);
  t.after(() => defaults.close());
  const port = Number(new URL(defaults.url).port);
  assert.ok(port >= 10000 && port <= 20000);
  assert.equal((await fetch(defaults.url)).status, 200);
});

test("last page disconnect stops service, while other pages and refresh keep it alive", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "canvas-note-tabs-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new DocumentStore(join(dir, "doc.json"));
  await store.newPage({ title: "Tabs" });
  const server = await startCanvasNoteServer({
    host: "127.0.0.1",
    port: 0,
    store,
    onReply: () => {},
  });
  t.after(() => server.close());
  const connect = async () => {
    const ws = new WebSocket(`${server.url.replace("http:", "ws:")}/ws`);
    t.after(() => ws.terminate());
    await inbox(ws)((message) => message.type === "snapshot");
    return ws;
  };
  const disconnect = async (ws: WebSocket) => {
    const done = once(ws, "close");
    ws.close();
    await done;
  };
  const first = await connect();
  const second = await connect();
  await disconnect(first);
  await delay(1600);
  assert.equal(
    (await fetch(server.url)).status,
    200,
    "another page keeps service alive",
  );
  await disconnect(second);
  const refreshed = await connect();
  await delay(1600);
  assert.equal(
    (await fetch(server.url)).status,
    200,
    "refresh cancels scheduled shutdown",
  );
  await disconnect(refreshed);
  await delay(1700);
  await assert.rejects(fetch(server.url));
  assert.equal((await store.read()).pages[0].title, "Tabs");
});

test("web shutdown message stops all browser connections", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "canvas-note-button-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new DocumentStore(join(dir, "doc.json"));
  await store.newPage({ title: "Button" });
  const server = await startCanvasNoteServer({
    host: "127.0.0.1",
    port: 0,
    store,
    onReply: () => {},
  });
  t.after(() => server.close());
  const ws = new WebSocket(`${server.url.replace("http:", "ws:")}/ws`);
  t.after(() => ws.terminate());
  const next = inbox(ws);
  await next((message) => message.type === "snapshot");
  const closed = once(ws, "close");
  ws.send(JSON.stringify({ type: "shutdown" }));
  await next((message) => message.type === "server:closing");
  await closed;
  await server.close();
  await assert.rejects(fetch(server.url));
});

test("real listeners use automatic local/SSH hosts and configured override", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "canvas-note-host-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const names = ["SSH_CONNECTION", "SSH_CLIENT", "SSH_TTY"];
  const original = names.map((name) => process.env[name]);
  t.after(() =>
    names.forEach((name, index) => {
      if (original[index] === undefined) delete process.env[name];
      else process.env[name] = original[index];
    }),
  );
  for (const name of names) delete process.env[name];
  const store = new DocumentStore(join(dir, "doc.json"));
  await store.newPage({ title: "Host selection" });
  const options = { port: 0, store, onReply: () => {} };
  const local = await startCanvasNoteServer(options);
  t.after(() => local.close());
  assert.equal(new URL(local.url).hostname, "localhost");
  assert.equal((await fetch(local.url)).status, 200);
  await local.close();
  process.env.SSH_CONNECTION = "192.0.2.1 1234 192.0.2.2 22";
  const ssh = await startCanvasNoteServer(options);
  t.after(() => ssh.close());
  assert.equal(
    (await fetch(`http://127.0.0.1:${new URL(ssh.url).port}`)).status,
    200,
  );
  await ssh.close();
  const overridden = await startCanvasNoteServer({
    ...options,
    host: "127.0.0.1",
  });
  t.after(() => overridden.close());
  assert.equal(new URL(overridden.url).hostname, "127.0.0.1");
  assert.equal((await fetch(overridden.url)).status, 200);
});

test("public-host environment changes advertised URLs without changing the real listener", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "canvas-note-public-host-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const original = process.env.CANVAS_NOTE_PUBLIC_HOST;
  t.after(() => {
    if (original === undefined) delete process.env.CANVAS_NOTE_PUBLIC_HOST;
    else process.env.CANVAS_NOTE_PUBLIC_HOST = original;
  });
  const store = new DocumentStore(join(dir, "doc.json"));
  await store.newPage({ title: "Public host" });
  process.env.CANVAS_NOTE_PUBLIC_HOST = "192.0.2.10";
  const server = await startCanvasNoteServer({
    host: "127.0.0.1",
    port: 0,
    store,
    onReply: () => {},
  });
  t.after(() => server.close());
  const address = new URL(server.url);
  assert.equal(address.hostname, "192.0.2.10");
  assert.equal((await fetch(`http://127.0.0.1:${address.port}`)).status, 200);
  await server.close();
  process.env.CANVAS_NOTE_PUBLIC_HOST = "localhost";
  const restarted = await startCanvasNoteServer({
    host: "127.0.0.1",
    port: 0,
    store,
    onReply: () => {},
  });
  t.after(() => restarted.close());
  assert.equal(new URL(restarted.url).hostname, "localhost");
  assert.equal((await fetch(restarted.url)).status, 200);
});
