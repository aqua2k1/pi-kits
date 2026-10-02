import assert from "node:assert/strict";
import type { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { homedir } from "node:os";
import { test } from "node:test";
import { isUrl, launchDetached, resolveTarget } from "./desktop-open.ts";

function launcher(event: "error" | "spawn") {
  const child = new EventEmitter();
  let unrefs = 0;
  Object.assign(child, {
    unref: () => {
      unrefs++;
    },
  });
  const spawnProcess = (() => {
    queueMicrotask(() => child.emit(event, new Error("fixture ENOENT")));
    return child;
  }) as unknown as typeof spawn;
  return { spawnProcess, unrefs: () => unrefs };
}

test("desktop launcher catches asynchronous errors without reporting success", async () => {
  const fake = launcher("error");
  assert.deepEqual(
    await launchDetached("xdg-open", ["file"], fake.spawnProcess),
    { ok: false, message: "Failed to open: fixture ENOENT" },
  );
  assert.equal(fake.unrefs(), 0);
});

test("desktop launcher detaches only after spawn succeeds", async () => {
  const fake = launcher("spawn");
  assert.deepEqual(
    await launchDetached("xdg-open", ["file"], fake.spawnProcess),
    { ok: true, message: "Opened with xdg-open" },
  );
  assert.equal(fake.unrefs(), 1);
});

test("desktop targets preserve URLs, home expansion and file completion", () => {
  assert.equal(
    resolveTarget(" https://example.com/a ", "/workspace"),
    "https://example.com/a",
  );
  assert.equal(resolveTarget("@@file.md", "/workspace"), "/workspace/file.md");
  assert.equal(
    resolveTarget("~/file.md", "/workspace"),
    `${homedir()}/file.md`,
  );
  assert.equal(isUrl("https://example.com"), true);
  assert.equal(isUrl("file.md"), false);
});
