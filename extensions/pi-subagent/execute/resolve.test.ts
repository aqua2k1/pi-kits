import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveExecutor } from "./resolve.ts";

test("resolveExecutor matches explicit priority order and falls back to subprocess", () => {
  assert.equal(resolveExecutor({}).id, "subprocess");
  assert.equal(resolveExecutor({ HC_TERMINAL_ID: "   " }).id, "subprocess");

  const core = resolveExecutor({ HC_TERMINAL_ID: "t1" });
  assert.equal(core.id, "herdr-core");
  assert.equal(core.supportsView, true);
  assert.equal(core.check_env(), true);
});

test("resolveExecutor pins the matched environment and creates a fresh executor per call", () => {
  const first = resolveExecutor({ HC_TERMINAL_ID: "t1" });
  const second = resolveExecutor({ HC_TERMINAL_ID: "t1" });
  assert.equal(first.id, "herdr-core");
  assert.equal(second.id, "herdr-core");
  assert.notEqual(first, second);

  const env: NodeJS.ProcessEnv = { HC_TERMINAL_ID: "t1" };
  const pinned = resolveExecutor(env);
  env.HC_TERMINAL_ID = "";
  assert.equal(pinned.check_env(), true);
});

test("resolveExecutor forwards warning callback to Herdr core executor", async () => {
  const warnings: string[] = [];
  const executor = resolveExecutor(
    { HC_TERMINAL_ID: "t1" },
    { warn: (message) => warnings.push(message) },
  );
  assert.equal(executor.id, "herdr-core");
  await assert.rejects(
    executor.focus_view?.({ id: "missing" }) ?? Promise.resolve(),
    /unowned_view/,
  );
  assert.deepEqual(warnings, []);
});
