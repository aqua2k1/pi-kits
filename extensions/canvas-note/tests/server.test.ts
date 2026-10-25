import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
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

test("HTTP serves the same shared ESM contracts with JavaScript MIME type", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "canvas-note-contracts-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new DocumentStore(join(dir, "doc.json"));
  const server = await startCanvasNoteServer({
    host: "127.0.0.1",
    port: 0,
    store,
    onReply: () => {},
  });
  t.after(() => server.close());
  const response = await fetch(`${server.url}/core/contracts.js`);
  assert.equal(response.status, 200);
  assert.equal(
    response.headers.get("content-type"),
    "text/javascript; charset=utf-8",
  );
  assert.equal(
    await response.text(),
    await readFile(new URL("../core/contracts.js", import.meta.url), "utf8"),
  );
  const head = await fetch(`${server.url}/core/contracts.js`, {
    method: "HEAD",
  });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
  const missing = await fetch(`${server.url}/core/model.ts`);
  assert.equal(missing.status, 404);
});

test("normal commits only send ordered operations; external edits and resync use snapshots", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "canvas-note-operations-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new DocumentStore(join(dir, "doc.json"));
  await store.newPage({ title: "Initial" });
  const errors: unknown[] = [];
  const server = await startCanvasNoteServer({
    host: "127.0.0.1",
    port: 0,
    store,
    onReply: () => {},
    onError: (error) => errors.push(error),
  });
  t.after(() => server.close());
  const ws = new WebSocket(`${server.url.replace("http:", "ws:")}/ws`);
  t.after(() => ws.terminate());
  const all: Record<string, unknown>[] = [];
  ws.on("message", (raw) => all.push(JSON.parse(raw.toString())));
  const next = inbox(ws);
  await next((msg) => msg.type === "snapshot");
  const other = new DocumentStore(store.path);
  await Promise.all(
    Array.from({ length: 12 }, (_, i) =>
      (i % 2 ? store : other).insert({
        blocks: [{ type: "text", spec: { md: String(i) } }],
      }),
    ),
  );
  await store.newPage({ title: "Next" });
  await server.flush();
  await next((msg) => msg.type === "operations" && msg.version === 14);
  // Let all rename notifications settle: none may duplicate tool commits as snapshots.
  await delay(100);
  assert.equal(all.filter((msg) => msg.type === "snapshot").length, 1);
  const operations = all.filter((msg) => msg.type === "operations");
  assert.deepEqual(
    operations.map((msg) => [msg.baseVersion, msg.version]),
    Array.from({ length: 13 }, (_, i) => [i + 1, i + 2]),
  );

  const external = await store.read();
  external.pages[0].title = "Same-version external edit";
  await writeFile(join(dir, "replacement"), JSON.stringify(external));
  await rename(join(dir, "replacement"), store.path);
  const changed = await next(
    (msg) =>
      msg.type === "snapshot" &&
      JSON.stringify(msg.doc) === JSON.stringify(external),
  );
  assert.deepEqual(changed.doc, external);

  // An external version gap followed immediately by a commit must not be
  // interpreted as an operation against the old browser baseline.
  external.version += 7;
  external.pages[0].title = "Gap";
  await writeFile(store.path, JSON.stringify(external));
  await store.newPage({ title: "After gap" });
  await server.flush();
  await next(
    (msg) =>
      (msg.type === "snapshot" &&
        (msg.doc as { version: number }).version === external.version + 1) ||
      (msg.type === "operations" && msg.version === external.version + 1),
  );
  // Queue the tool mutation before writing externally, so its commit is
  // guaranteed to beat the watcher's queued read (including same-version edits).
  const raced = await store.read();
  raced.pages[0].title = "External baseline before commit";
  let committing!: Promise<{ pageId: string }>;
  await withFileMutationQueue(store.path, async () => {
    committing = store.newPage({ title: "Raced commit" });
    await writeFile(store.path, JSON.stringify(raced));
  });
  await committing;
  await server.flush();
  const fallback = await next(
    (msg) =>
      msg.type === "snapshot" &&
      (msg.doc as { version: number }).version === raced.version + 1,
  );
  assert.deepEqual(fallback.doc, await store.read());
  for (let i = 1, version = 1; i < all.length; i++) {
    const msg = all[i];
    if (msg.type === "snapshot")
      version = (msg.doc as { version: number }).version;
    if (msg.type === "operations") {
      assert.equal(
        msg.baseVersion,
        version,
        "no operation may follow a snapshot with an obsolete baseline",
      );
      version = msg.version as number;
    }
  }
  const resynced = once(ws, "message");
  ws.send(JSON.stringify({ type: "resync" }));
  const message = JSON.parse((await resynced)[0].toString());
  assert.equal(message.type, "snapshot");
  assert.deepEqual(message.doc, await store.read());
  assert.deepEqual(errors, []);
});

test("connection snapshots and resync cannot be followed by older operations", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "canvas-note-order-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new DocumentStore(join(dir, "doc.json"));
  await store.newPage({ title: "Initial" });
  const server = await startCanvasNoteServer({
    host: "127.0.0.1",
    port: 0,
    store,
    onReply: () => {},
  });
  t.after(() => server.close());
  const ws = new WebSocket(`${server.url.replace("http:", "ws:")}/ws`);
  t.after(() => ws.terminate());
  const versions: number[] = [];
  ws.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === "snapshot") versions.push(msg.doc.version);
    if (msg.type === "operations") versions.push(msg.version);
  });
  const next = inbox(ws);
  const writing = Promise.all(
    Array.from({ length: 20 }, (_, i) => store.newPage({ title: String(i) })),
  );
  await next((msg) => msg.type === "snapshot");
  ws.send(JSON.stringify({ type: "resync" }));
  await writing;
  await server.flush();
  await next(
    (msg) =>
      (msg.type === "snapshot"
        ? (msg.doc as { version: number }).version
        : msg.version) === 21,
  );
  await delay(50);
  assert.deepEqual(
    versions,
    [...versions].sort((a, b) => a - b),
  );
  assert.equal(versions.at(-1), 21);
});

test("close cancels queued captures and commit publications and unsubscribes", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "canvas-note-cancel-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new DocumentStore(join(dir, "doc.json"));
  await store.newPage({ title: "Initial" });
  const errors: unknown[] = [];
  const server = await startCanvasNoteServer({
    host: "127.0.0.1",
    port: 0,
    store,
    onReply: () => {},
    onError: (error) => errors.push(error),
  });
  t.after(() => server.close());
  const ws = new WebSocket(`${server.url.replace("http:", "ws:")}/ws`);
  t.after(() => ws.terminate());
  const next = inbox(ws);
  await next((msg) => msg.type === "snapshot");
  const publications: string[] = [];
  ws.on("message", (raw) => publications.push(JSON.parse(raw.toString()).type));
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
  const committing = store.newPage({ title: "Queued commit" });
  ws.send(JSON.stringify({ type: "resync" }));
  ws.send(JSON.stringify({ type: "invalid", requestId: "probe" }));
  await next((msg) => msg.type === "error" && msg.requestId === "probe");
  publications.length = 0;
  const stopping = server.close();
  release();
  await Promise.all([lock, committing, stopping]);
  await store.newPage({ title: "After close" });
  assert.deepEqual(publications, ["server:closing"]);
  assert.deepEqual(errors, []);
});

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
    "/theme.css",
    "/vendor/marked.js",
    "/vendor/purify.js",
    "/vendor/echarts.js",
    "/vendor/highlight.js",
    "/vendor/highlight.css",
    "/vendor/katex.js",
    "/vendor/katex.css",
    "/vendor/fonts/KaTeX_Main-Regular.woff2",
  ])
    assert.equal((await fetch(server.url + path)).status, 200, path);
  const theme = await fetch(`${server.url}/theme.css?v=1`);
  assert.match(theme.headers.get("content-type") ?? "", /text\/css/);
  assert.equal(theme.headers.get("cache-control"), "no-store");
  assert.match(await theme.text(), /--accent: #[\da-f]+;/i);
  const themeHead = await fetch(`${server.url}/theme.css`, { method: "HEAD" });
  assert.equal(themeHead.status, 200);
  assert.equal(await themeHead.text(), "");
  assert.equal((await fetch(`${server.url}/missing`)).status, 404);
  const ws = new WebSocket(`${server.url.replace("http:", "ws:")}/ws`);
  const next = inbox(ws);
  t.after(() => ws.terminate());
  const initialSnapshot = await next((msg) => msg.type === "snapshot");
  assert.equal(initialSnapshot.documentId, basename(dir));
  await store.update({
    blocks: [{ blockId: inserted.blockIds[0], spec: { md: "fixed" } }],
  });
  const operations = await next((msg) => msg.type === "operations");
  assert.equal(operations.documentId, basename(dir));
  assert.equal(operations.baseVersion, 1);
  assert.equal(operations.version, 2);
  assert.deepEqual(operations.operations, [
    {
      type: "blocks:update",
      blocks: (await store.read()).pages[0].blocks,
      removed: [],
    },
  ]);
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
