import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { useAgentDir } from "../../tests/helpers/agent-dir.ts";
import statsExtension from "./index.ts";

for (const [config, enabled] of [
  [undefined, true],
  [{ usage: { enabled: false } }, false],
  [{ usage: { stats: { enabled: false } } }, false],
  [{ usage: { stats: { enabled: true } } }, true],
  [{ stats: { enabled: false } }, false],
  [{ stats: { enabled: true } }, true],
] as const) {
  test(`stats factory respects configuration ${JSON.stringify(config)}`, (t) => {
    useAgentDir(t, config);
    const commands: string[] = [];
    statsExtension({
      registerCommand(name: string) {
        commands.push(name);
      },
      on() {
        assert.fail("Stats must not register lifecycle hooks");
      },
      registerFlag() {
        assert.fail("Stats must not register flags");
      },
    } as unknown as ExtensionAPI);
    assert.deepEqual(commands, enabled ? ["stats"] : []);
  });
}
