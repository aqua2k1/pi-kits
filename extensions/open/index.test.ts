import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { useAgentDir } from "../../tests/helpers/agent-dir.ts";
import openExtension from "./index.ts";

for (const [config, enabled] of [
  [undefined, true],
  [{ workspace: { enabled: false } }, false],
  [{ workspace: { open: { enabled: false } } }, false],
  [{ workspace: { open: { enabled: true } } }, true],
  [{ open: { enabled: false } }, false],
  [{ open: { enabled: true } }, true],
] as const) {
  test(`open factory respects configuration ${JSON.stringify(config)}`, (t) => {
    useAgentDir(t, config);
    const commands: string[] = [];
    const tools: string[] = [];
    openExtension({
      registerCommand(name: string) {
        commands.push(name);
      },
      registerTool(tool: { name: string }) {
        tools.push(tool.name);
      },
    } as unknown as ExtensionAPI);
    assert.deepEqual(commands, enabled ? ["open"] : []);
    assert.deepEqual(tools, enabled ? ["open"] : []);
  });
}
