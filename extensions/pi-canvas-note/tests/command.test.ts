import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { WebSocket } from "ws";
import { DocumentStore } from "../core/store.ts";
import canvasNote from "../index.ts";

test("server command starts an empty canvas silently, reuses it, resumes its document and recovers from errors", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "canvas-note-command-"));
  const environment = ["PI_CODING_AGENT_DIR", "CANVAS_NOTE_PUBLIC_HOST"];
  const original = environment.map((name) => process.env[name]);
  process.env.PI_CODING_AGENT_DIR = dir;
  process.env.CANVAS_NOTE_PUBLIC_HOST = "127.0.0.1";
  const commands = new Map<
    string,
    Parameters<ExtensionAPI["registerCommand"]>[1]
  >();
  const events = new Map<string, () => Promise<void>>();
  const branch: { type: string; customType: string; data: { id: string } }[] =
    [];
  const notifications: { text: string; type: string }[] = [];
  const statuses = new Map<string, string>();
  const pi = {
    registerTool: () => {},
    registerCommand: (
      name: string,
      command: Parameters<ExtensionAPI["registerCommand"]>[1],
    ) => commands.set(name, command),
    appendEntry: (customType: string, data: { id: string }) =>
      branch.push({ type: "custom", customType, data }),
    on: (name: string, handler: () => Promise<void>) =>
      events.set(name, handler),
    sendMessage: () => assert.fail("Server command must not call the model"),
    sendUserMessage: () =>
      assert.fail("Server command must not call the model"),
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd: dir,
    sessionManager: { getBranch: () => branch },
    ui: {
      setStatus: (key: string, text: string | undefined) => {
        if (text === undefined) statuses.delete(key);
        else statuses.set(key, text);
      },
      notify: (text: string, type: string) =>
        notifications.push({ text, type }),
    },
  } as unknown as ExtensionCommandContext;
  t.after(async () => {
    await events.get("session_shutdown")?.();
    environment.forEach((name, index) => {
      if (original[index] === undefined) delete process.env[name];
      else process.env[name] = original[index];
    });
    await rm(dir, { recursive: true, force: true });
  });
  const start = async (args = "") => {
    const command = commands.get("canvas-note-server");
    assert.ok(command);
    await command.handler(args, ctx);
  };
  const url = () => {
    const status = statuses.get("canvas-note");
    assert.ok(status);
    return status.replace("Canvas Note: ", "");
  };
  const snapshot = async () => {
    const ws = new WebSocket(`${url().replace("http:", "ws:")}/ws`);
    t.after(() => ws.terminate());
    const [raw] = await once(ws, "message");
    ws.terminate();
    return JSON.parse(raw.toString()).doc;
  };

  canvasNote(pi);
  assert.equal(statuses.size, 0, "registration does not start the server");
  await start("stop");
  assert.equal(
    branch.length,
    0,
    "invalid arguments do not allocate a document",
  );
  assert.deepEqual(notifications.splice(0), [
    { text: "Usage: /canvas-note-server", type: "error" },
  ]);
  await Promise.all([start(), start()]);
  const firstUrl = url();
  assert.equal((await fetch(firstUrl)).status, 200);
  assert.equal(branch.length, 1);
  assert.deepEqual([...notifications], []);
  assert.deepEqual(await snapshot(), { version: 0, pages: [] });
  const path = join(dir, "docs", "canvas-notes", branch[0].data.id, "doc.json");
  await assert.rejects(readFile(path), { code: "ENOENT" });
  await start();
  assert.equal(url(), firstUrl);

  const store = new DocumentStore(path);
  await store.insertBlocks({
    blocks: [{ type: "text", spec: { md: "Original document" } }],
  });
  const originalDoc = await readFile(path, "utf8");
  await events.get("session_shutdown")?.();
  assert.equal(statuses.size, 0);
  await assert.rejects(fetch(firstUrl));

  canvasNote(pi);
  await start();
  assert.equal(branch.length, 1, "resuming uses the saved document ID");
  assert.deepEqual(await snapshot(), JSON.parse(originalDoc));
  assert.equal(await readFile(path, "utf8"), originalDoc);
  assert.deepEqual([...notifications], []);
  await events.get("session_shutdown")?.();

  process.env.CANVAS_NOTE_PUBLIC_HOST = "invalid/host";
  await start();
  assert.equal(statuses.size, 0);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].type, "error");
  process.env.CANVAS_NOTE_PUBLIC_HOST = "127.0.0.1";
  await start();
  assert.equal((await fetch(url())).status, 200);
  assert.equal(
    notifications.length,
    1,
    "successful retry sends no notification",
  );
  assert.equal(branch.length, 1);
  assert.equal(await readFile(path, "utf8"), originalDoc);
});
