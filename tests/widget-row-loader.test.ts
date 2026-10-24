import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { useAgentDir } from "./helpers/agent-dir.ts";

const root = fileURLToPath(new URL("../", import.meta.url));

// A fresh Node process avoids tsx's shared module cache and exercises the same
// independent Jiti instances that Pi uses when it loads extension entry points.
test("independently loaded extensions preserve both widget contributors across refresh and reload", (t) => {
  const agentDir = useAgentDir(t);
  const child = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
      import assert from "node:assert/strict";
      import { resolve } from "node:path";
      import { loadExtensions } from "./node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js";

      globalThis.fetch = async () => Response.json({
        is_available: true,
        balance_infos: [{ currency: "CNY", total_balance: "110.00" }],
      });
      let widget;
      let mounts = 0;
      let invalidations = 0;
      const ctx = {
        mode: "tui",
        model: { provider: "deepseek" },
        ui: {
          setWidget(_id, content) {
            if (content === undefined) { widget = undefined; return; }
            mounts++;
            widget = content(
              { requestRender() { invalidations++; } },
              { fg: (_tone, text) => text },
            );
          },
          notify() {},
        },
        modelRegistry: { getApiKeyForProvider: async () => "fixture-token" },
      };
      const paths = [
        resolve("extensions/provider-usage/index.ts"),
        resolve("extensions/token-meter/index.ts"),
      ];
      async function emit(extensions, name, event = {}) {
        for (const extension of extensions) {
          for (const handler of extension.handlers.get(name) ?? []) {
            await handler({ type: name, ...event }, ctx);
          }
        }
        await new Promise(resolve => setImmediate(resolve));
      }
      function text() {
        assert.equal(typeof widget?.render, "function");
        return widget.render(100)[0];
      }
      for (const entries of [paths, [...paths].reverse(), paths]) {
        const loaded = await loadExtensions(entries, process.cwd());
        assert.deepEqual(loaded.errors, []);
        try {
          await emit(loaded.extensions, "session_start");
          assert.ok(text().startsWith("DeepSeek"), text());
          assert.ok(text().endsWith("TTFT — · TPS —"), text());
          const parent = widget;
          const mountCount = mounts;
          for (let attempt = 0; attempt < 2; attempt++) {
            await emit(loaded.extensions, "turn_start");
            await emit(loaded.extensions, "before_provider_request");
            await emit(loaded.extensions, "message_start", { message: { role: "assistant" } });
            await emit(loaded.extensions, "message_end", {
              message: { role: "assistant", stopReason: "stop", usage: { output: 315 }, durationMs: 5000 },
            });
            assert.ok(text().startsWith("DeepSeek"), text());
            assert.ok(text().endsWith("TTFT — · TPS 63 token/s"), text());
            await emit(loaded.extensions, "model_select", { model: { provider: "deepseek" } });
            assert.ok(text().startsWith("DeepSeek"), text());
            assert.ok(text().endsWith("TTFT — · TPS 63 token/s"), text());
          }
          assert.equal(widget, parent);
          assert.equal(mounts, mountCount);
          assert.ok(invalidations > 0);
          await emit(loaded.extensions, "model_select", { model: { provider: "unsupported" } });
          assert.equal(text().trimStart(), "TTFT — · TPS 63 token/s");
        } finally {
          await emit(loaded.extensions, "session_shutdown");
        }
        assert.equal(widget, undefined);
      }
    `,
    ],
    {
      cwd: root,
      env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, NODE_OPTIONS: "" },
      encoding: "utf8",
      timeout: 30_000,
    },
  );
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0, child.stdout + child.stderr);
});
