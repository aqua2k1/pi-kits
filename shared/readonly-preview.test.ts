import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { test } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readonlyPreview } from "./readonly-preview.ts";

const ctx = {
  mode: "tui",
  sessionManager: { getSessionId: () => "test/session" },
} as unknown as ExtensionContext;

test("preview launches read-only nvim and removes private temporary data", async () => {
  let file = "";
  const result = await readonlyPreview(
    ctx,
    { prefix: "pi-preview-test-", extension: "md", body: "hello" },
    async (_ctx, command, options) => {
      assert.equal(command, "nvim");
      assert.equal(options?.args?.[0], "-R");
      assert.equal(options?.clearScreen, true);
      file = options?.args?.[1] ?? "";
      assert.equal(readFileSync(file, "utf8"), "hello\n");
      assert.equal(statSync(file).mode & 0o777, 0o600);
      return { kind: "exited", status: 0, signal: null };
    },
  );
  assert.equal(result.kind, "exited");
  assert.equal(existsSync(dirname(file)), false);
});

test("preview cleans up after a thrown launcher error", async () => {
  let file = "";
  await assert.rejects(
    readonlyPreview(
      ctx,
      { prefix: "pi-preview-test-", extension: "json", body: "{}" },
      async (_ctx, _command, options) => {
        file = options?.args?.[1] ?? "";
        throw new Error("fixture launch failure");
      },
    ),
    /fixture launch failure/,
  );
  assert.equal(existsSync(dirname(file)), false);
});

test("non-TUI preview never writes or launches", async () => {
  const result = await readonlyPreview(
    { mode: "rpc" } as ExtensionContext,
    { prefix: "pi-preview-test-", extension: "md", body: "secret" },
    async () => {
      assert.fail("must not launch");
    },
  );
  assert.deepEqual(result, { kind: "unavailable" });
});

test("readonly preview accepts the configured vim-compatible editor", async () => {
  const result = await readonlyPreview(
    ctx,
    {
      prefix: "pi-preview-test-",
      extension: "md",
      body: "hello",
      editor: "vim",
    },
    async (_ctx, command, options) => {
      assert.equal(command, "vim");
      assert.equal(options?.args?.[0], "-R");
      return { kind: "exited", status: 0, signal: null };
    },
  );
  assert.equal(result.kind, "exited");
});
