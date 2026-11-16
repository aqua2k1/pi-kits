import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { useAgentDir } from "../../tests/helpers/agent-dir.ts";
import openExtension from "./index.ts";

for (const [config, enabled] of [
  [undefined, true],
  [{ "pi-open": { enabled: false } }, false],
  [{ "pi-open": { enabled: true } }, true],
  // Old group and feature keys are unknown raw fields, not aliases.
  [{ workspace: { enabled: false } }, true],
  [{ workspace: { open: { enabled: false } } }, true],
  [{ open: { enabled: false } }, true],
  [{ open: { enabled: false }, "pi-open": {} }, true],
  [{ open: { enabled: true }, "pi-open": { enabled: false } }, false],
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
