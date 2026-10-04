import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { useAgentDir } from "../../tests/helpers/agent-dir.ts";
import terminalExtension from "./index.ts";

for (const [config, enabled] of [
  [undefined, true],
  [{ workspace: { enabled: false } }, false],
  [{ workspace: { terminal: { enabled: false } } }, false],
  [{ workspace: { terminal: { enabled: true } } }, true],
  [{ terminal: { enabled: false } }, false],
  [{ terminal: { enabled: true } }, true],
] as const) {
  test(`terminal factory respects configuration ${JSON.stringify(config)}`, (t) => {
    useAgentDir(t, config);
    const commands: string[] = [];
    terminalExtension({
      registerCommand(name: string) {
        commands.push(name);
      },
      on() {
        assert.fail("Terminal must not register lifecycle hooks");
      },
    } as unknown as ExtensionAPI);
    assert.deepEqual(commands, enabled ? ["vim", "lg", "fm"] : []);
  });
}
