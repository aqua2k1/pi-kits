import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { runTerminalApp } from "./terminal-app.ts";

function context(calls: string[]) {
  return {
    mode: "tui",
    cwd: process.cwd(),
    ui: {
      custom: async (
        factory: (
          tui: unknown,
          theme: unknown,
          keys: unknown,
          done: (result: unknown) => void,
        ) => unknown,
      ) => {
        let result: unknown;
        factory(
          {
            stop: () => calls.push("stop"),
            start: () => calls.push("start"),
            requestRender: () => calls.push("render"),
          },
          undefined,
          undefined,
          (value) => {
            result = value;
          },
        );
        return result;
      },
    },
  } as unknown as ExtensionContext;
}

test("terminal restores the TUI after a successful child", async () => {
  const calls: string[] = [];
  const result = await runTerminalApp(context(calls), process.execPath, {
    args: ["-e", "process.exit(0)"],
  });
  assert.deepEqual(result, { kind: "exited", status: 0, signal: null });
  assert.deepEqual(calls, ["stop", "start", "render"]);
});

test("terminal restores the TUI after a missing executable", async () => {
  const calls: string[] = [];
  const result = await runTerminalApp(
    context(calls),
    "pi-kits-nonexistent-test-executable",
  );
  assert.equal(result.kind, "not-found");
  assert.deepEqual(calls, ["stop", "start", "render"]);
});

test("terminal refuses RPC and print modes without UI calls", async () => {
  for (const mode of ["rpc", "print", "json"]) {
    assert.deepEqual(
      await runTerminalApp({ mode } as ExtensionContext, "nvim"),
      { kind: "unavailable" },
    );
  }
});
