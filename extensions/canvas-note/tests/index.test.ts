import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionAPI,
  type ExtensionContext,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { WebSocket } from "ws";
import canvasNote from "../index.ts";

test("extension registers only four tools; real handlers lazily serve and route browser feedback", async (t) => {
  const agentDir = await mkdtemp(join(tmpdir(), "canvas-note-extension-"));
  const original = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(async () => {
    if (original === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = original;
    await rm(agentDir, { recursive: true, force: true });
  });
  const portProbe = createServer();
  await new Promise<void>((resolve) =>
    portProbe.listen(0, "127.0.0.1", resolve),
  );
  const address = portProbe.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((resolve) => portProbe.close(() => resolve()));
  await writeFile(
    join(agentDir, "pi-kits.json"),
    JSON.stringify({ "canvas-note": { portRange: [port, port] } }),
  );
  type Tool = {
    name: string;
    execute: (
      id: string,
      params: unknown,
      signal: undefined,
      update: undefined,
      ctx: ExtensionContext,
    ) => Promise<{
      content: unknown;
      details: unknown;
      structuredContent: unknown;
    }>;
  };
  const tools = new Map<string, Tool>();
  const events = new Map<string, () => Promise<void>>();
  const messages: string[] = [];
  const statuses = new Map<string, string>();
  const pi = {
    registerTool: (tool: Tool) => tools.set(tool.name, tool),
    registerCommand: () =>
      assert.fail("Canvas Note must not register commands"),
    appendEntry: () => {},
    on: (event: string, fn: () => Promise<void>) => events.set(event, fn),
    sendUserMessage: (text: string) => messages.push(text),
  } as unknown as ExtensionAPI;
  canvasNote(pi);
  t.after(() => events.get("session_shutdown")?.());
  assert.deepEqual([...tools.keys()].sort(), [
    "insert_blocks",
    "insert_page",
    "update_blocks",
    "update_page",
  ]);
  const ctx = {
    cwd: agentDir,
    sessionManager: { getSessionId: () => "integration", getBranch: () => [] },
    ui: {
      setStatus: (key: string, value: string | undefined) => {
        if (value === undefined) statuses.delete(key);
        else statuses.set(key, value);
      },
      notify: () => {},
    },
  } as unknown as ExtensionContext;
  const messagesByTool: Record<string, string> = {
    insert_page: "Page inserted.",
    update_page: "Page updated.",
    insert_blocks: "Blocks inserted.",
    update_blocks: "Blocks updated.",
  };
  const call = async (name: string, params: unknown) => {
    const result = await tools
      .get(name)
      ?.execute("test", params, undefined, undefined, ctx);
    assert.ok(result);
    assert.deepEqual(result.content, [
      { type: "text", text: messagesByTool[name] },
    ]);
    assert.deepEqual(result.details, result.structuredContent);
    return result.structuredContent as Record<string, unknown>;
  };
  const page = await call("insert_page", { title: "真实工具测试" });
  assert.equal(
    statuses.has("canvas-note"),
    false,
    "empty pages do not show an active server",
  );
  assert.equal(
    String(page.documentPath).startsWith(
      join(agentDir, "docs", "canvas-notes"),
    ),
    true,
  );
  assert.equal(basename(String(page.documentPath)), "doc.json");
  assert.match(
    basename(dirname(String(page.documentPath))),
    /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z-[0-9a-f-]{36}$/,
  );
  await assert.rejects(fetch(`http://127.0.0.1:${port}`));
  const inserted = await call("insert_blocks", {
    pageId: page.pageId,
    blocks: [
      { type: "text", spec: { md: "Hello" } },
      { type: "math", spec: { latex: "x^2" } },
    ],
  });
  assert.equal((await fetch(String(inserted.url))).status, 200);
  assert.equal(statuses.get("canvas-note"), `Canvas Note: ${inserted.url}`);
  const ws = new WebSocket(
    `${String(inserted.url).replace("http:", "ws:")}/ws`,
  );
  t.after(() => ws.terminate());
  const snapshotPromise = once(ws, "message");
  const [raw] = await snapshotPromise;
  const doc = JSON.parse(raw.toString()).doc;
  const response = once(ws, "message");
  ws.send(
    JSON.stringify({
      type: "reply",
      requestId: "integration",
      version: doc.version,
      blockIds: inserted.blockIds,
      reply: "修改这两个",
    }),
  );
  assert.equal(JSON.parse((await response)[0].toString()).type, "ack");
  assert.equal(messages.length, 1);
  assert.match(messages[0], /修改这两个/);
  assert.equal(messages[0].includes("Hello"), false);
  assert.equal(messages[0].includes("x^2"), false);
  const feedback = JSON.parse(
    await readFile(
      join(dirname(String(page.documentPath)), "feedback-integration.json"),
      "utf8",
    ),
  );
  assert.equal(feedback.reply, "修改这两个");
  assert.equal(feedback.blocks[0].block.spec.md, "Hello");
  assert.equal(feedback.blocks[1].block.spec.latex, "x^2");
  assert.ok(messages[0].includes("integration.json"));
  const publications: { type: string; baseVersion: number; version: number }[] =
    [];
  ws.on("message", (raw) => publications.push(JSON.parse(raw.toString())));
  await call("update_blocks", {
    blocks: [
      { blockId: (inserted.blockIds as string[])[0], spec: { md: "Updated" } },
    ],
  });
  await call("insert_page", { title: "Live page" });
  await call("insert_blocks", {
    blocks: [{ type: "text", spec: { md: "Live insert" } }],
  });
  await delay(100);
  assert.deepEqual(
    publications.map((msg) => msg.type),
    ["operations", "operations", "operations"],
  );
  assert.deepEqual(
    publications.map((msg) => [msg.baseVersion, msg.version]),
    [
      [2, 3],
      [3, 4],
      [4, 5],
    ],
  );
  const renamedMessage = once(ws, "message");
  const renamed = await call("update_page", {
    pageId: page.pageId,
    change: { kind: "rename", title: "重命名" },
  });
  assert.equal(renamed.deleted, false);
  assert.equal(renamed.version, 6);
  assert.deepEqual(
    JSON.parse((await renamedMessage)[0].toString()).operations,
    [
      {
        type: "page:update",
        pageId: page.pageId,
        change: { kind: "rename", title: "重命名" },
      },
    ],
  );
  const deletedMessage = once(ws, "message");
  const extra = JSON.parse(await readFile(String(page.documentPath), "utf8"))
    .pages[1];
  const deleted = await call("update_page", {
    pageId: extra.id,
    change: { kind: "delete" },
  });
  assert.equal(deleted.deleted, true);
  assert.equal(deleted.version, 7);
  assert.deepEqual(
    JSON.parse((await deletedMessage)[0].toString()).operations,
    [{ type: "page:update", pageId: extra.id, change: { kind: "delete" } }],
  );
  const disconnected = once(ws, "close");
  ws.close();
  await disconnected;
  await delay(1700);
  await assert.rejects(fetch(String(inserted.url)));
  assert.equal(
    statuses.has("canvas-note"),
    false,
    "closing the last page clears the status",
  );
  assert.deepEqual(
    JSON.parse(
      await readFile(
        join(dirname(String(page.documentPath)), "feedback-integration.json"),
        "utf8",
      ),
    ),
    feedback,
    "document updates and server shutdown must retain the original feedback snapshot",
  );
  const offline = await call("update_page", {
    pageId: page.pageId,
    change: { kind: "rename", title: "离线重命名" },
  });
  assert.equal(offline.deleted, false);
  await assert.rejects(fetch(String(inserted.url)));
  const reopened = await call("update_blocks", {
    blocks: [
      {
        blockId: (inserted.blockIds as string[])[0],
        spec: { md: "Restarted" },
      },
    ],
  });
  assert.equal((await fetch(String(reopened.url))).status, 200);
  assert.equal(reopened.documentPath, inserted.documentPath);
  assert.equal(statuses.get("canvas-note"), `Canvas Note: ${reopened.url}`);
  await events.get("session_shutdown")?.();
  assert.equal(
    statuses.has("canvas-note"),
    false,
    "session shutdown clears the status",
  );
});

test("real Pi SDK loads Canvas Note and dispatches its lifecycle and tools", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "canvas-note-sdk-"));
  const original = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  t.after(async () => {
    if (original === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = original;
    await rm(dir, { recursive: true, force: true });
  });
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const address = probe.address();
  assert.ok(address && typeof address !== "string");
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  await writeFile(
    join(dir, "pi-kits.json"),
    JSON.stringify({
      "canvas-note": { portRange: [address.port, address.port] },
    }),
  );
  const settingsManager = SettingsManager.inMemory();
  const resourceLoader = new DefaultResourceLoader({
    cwd: dir,
    agentDir: dir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [canvasNote],
  });
  await resourceLoader.reload();
  const { session } = await createAgentSession({
    cwd: dir,
    agentDir: dir,
    settingsManager,
    resourceLoader,
    sessionManager: SessionManager.inMemory(),
    noTools: "builtin",
  });
  t.after(() => session.dispose());
  await session.bindExtensions({});
  t.after(() =>
    session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }),
  );
  const ctx = {
    ...session.extensionRunner.createContext(),
    tools: [],
    executeTool: async () => {
      throw new Error("Nested tools are not used in this test");
    },
  };
  const page = session.getToolDefinition("insert_page");
  const insert = session.getToolDefinition("insert_blocks");
  assert.ok(page && insert);
  assert.deepEqual(session.getActiveToolNames().sort(), [
    "insert_blocks",
    "insert_page",
    "update_blocks",
    "update_page",
  ]);
  await page.execute(
    "sdk-page",
    { title: "SDK 报告" },
    undefined,
    undefined,
    ctx,
  );
  await assert.rejects(fetch(`http://127.0.0.1:${address.port}`));
  const result = await insert.execute(
    "sdk-insert",
    { blocks: [{ type: "text", spec: { md: "**Real Pi SDK**" } }] },
    undefined,
    undefined,
    ctx,
  );
  const { url } = result.structuredContent as { url: string };
  assert.equal((await fetch(url)).status, 200);
  const originalPath = (result.structuredContent as { documentPath: string })
    .documentPath;
  assert.equal(
    originalPath.startsWith(join(dir, "docs", "canvas-notes")),
    true,
  );
  await session.reload();
  await assert.rejects(fetch(url));
  const reloadedPage = session.getToolDefinition("insert_page");
  assert.ok(reloadedPage);
  const reopened = await reloadedPage.execute(
    "sdk-reload",
    { title: "重载后" },
    undefined,
    undefined,
    {
      ...session.extensionRunner.createContext(),
      tools: [],
      executeTool: ctx.executeTool,
    },
  );
  assert.equal(
    (reopened.structuredContent as { documentPath: string }).documentPath,
    originalPath,
  );
  assert.equal(basename(originalPath), "doc.json");
  assert.match(
    basename(dirname(originalPath)),
    /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z-[0-9a-f-]{36}$/,
  );
  const saved = JSON.parse(await readFile(originalPath, "utf8"));
  assert.equal(saved.pages.length, 2);
  assert.equal(saved.pages[0].blocks[0].spec.md, "**Real Pi SDK**");
});

test("SSH address checks warn once for missing environment override and stay quiet otherwise", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "canvas-note-warning-"));
  const names = [
    "PI_CODING_AGENT_DIR",
    "SSH_CONNECTION",
    "SSH_CLIENT",
    "SSH_TTY",
    "CANVAS_NOTE_PUBLIC_HOST",
  ];
  const original = names.map((name) => process.env[name]);
  t.after(async () => {
    names.forEach((name, index) => {
      if (original[index] === undefined) delete process.env[name];
      else process.env[name] = original[index];
    });
    await rm(dir, { recursive: true, force: true });
  });
  for (const name of names) delete process.env[name];
  process.env.PI_CODING_AGENT_DIR = dir;
  const handlers = new Map<
    string,
    (event: unknown, ctx: ExtensionContext) => unknown
  >();
  const warnings: { text: string; type: string }[] = [];
  const pi = {
    registerTool: () => {},
    on: (
      name: string,
      handler: (event: unknown, ctx: ExtensionContext) => unknown,
    ) => handlers.set(name, handler),
  } as unknown as ExtensionAPI;
  const ctx = {
    sessionManager: { getBranch: () => [] },
    ui: {
      notify: (text: string, type: string) => warnings.push({ text, type }),
    },
  } as unknown as ExtensionContext;
  canvasNote(pi);
  await handlers.get("session_start")?.({}, ctx);
  assert.equal(warnings.length, 0, "local sessions do not warn");
  process.env.SSH_CONNECTION = "192.0.2.1 1234 192.0.2.2 22";
  await handlers.get("session_start")?.({}, ctx);
  await handlers.get("session_start")?.({}, ctx);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].type, "warning");
  assert.match(warnings[0].text, /CANVAS_NOTE_PUBLIC_HOST/);
  process.env.CANVAS_NOTE_PUBLIC_HOST = "192.0.2.10";
  canvasNote(pi);
  await handlers.get("session_start")?.({}, ctx);
  assert.equal(warnings.length, 1, "configured SSH sessions do not warn");
  process.env.CANVAS_NOTE_PUBLIC_HOST = "  ";
  canvasNote(pi);
  await handlers.get("session_start")?.({}, ctx);
  assert.equal(warnings.length, 2, "blank overrides count as missing");
});
