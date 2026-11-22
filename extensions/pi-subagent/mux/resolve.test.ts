import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveMux } from "./resolve.ts";

test("resolveMux matches explicit priority order without probing CLIs", () => {
  assert.equal(resolveMux({}), undefined);
  assert.equal(resolveMux({ HC_TERMINAL_ID: "   " }), undefined);
  assert.equal(resolveMux({ HERDR_ENV: "0" }), undefined);

  const legacy = resolveMux({ HERDR_ENV: "1" });
  assert.equal(legacy?.id, "herdr");
  assert.equal(legacy?.check_env(), true);

  const app = resolveMux({ HC_TERMINAL_ID: "t1" });
  assert.equal(app?.id, "herdr-app");
  assert.equal(app?.check_env(), true);

  const both = resolveMux({ HC_TERMINAL_ID: "t1", HERDR_ENV: "1" });
  assert.equal(both?.id, "herdr-app");
});

test("resolveMux pins the matched environment and creates a fresh adapter per call", () => {
  const first = resolveMux({ HERDR_ENV: "1" });
  const second = resolveMux({ HERDR_ENV: "1" });
  assert.equal(first?.id, "herdr");
  assert.equal(second?.id, "herdr");
  assert.notEqual(first, second);

  const env: NodeJS.ProcessEnv = { HERDR_ENV: "1" };
  const pinned = resolveMux(env);
  env.HERDR_ENV = "0";
  assert.equal(pinned?.check_env(), true);
});

test("resolveMux forwards warning callback to Herdr app adapter", async () => {
  const warnings: string[] = [];
  const adapter = resolveMux(
    { HC_TERMINAL_ID: "t1" },
    { warn: (message) => warnings.push(message) },
  );
  assert.equal(adapter?.id, "herdr-app");
  await assert.rejects(adapter.focus_view({ id: "missing" }), /unowned_view/);
  assert.deepEqual(warnings, []);
});
