import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { useAgentDir } from "../../tests/helpers/agent-dir.ts";
import contextPreviewExtension from "./index.ts";

for (const [config, enabled] of [
  [undefined, true],
  [{ workspace: { enabled: false } }, false],
  [{ workspace: { contextPreview: { enabled: false } } }, false],
  [{ workspace: { contextPreview: { enabled: true } } }, true],
  [{ contextPreview: { enabled: false } }, false],
  [{ contextPreview: { enabled: true } }, true],
] as const) {
  test(`context-preview factory respects configuration ${JSON.stringify(config)}`, (t) => {
    useAgentDir(t, config);
    const commands: string[] = [];
    const hooks: string[] = [];
    contextPreviewExtension({
      registerCommand(name: string) {
        commands.push(name);
      },
      on(name: string) {
        hooks.push(name);
      },
    } as unknown as ExtensionAPI);
    assert.deepEqual(commands, enabled ? ["context-preview"] : []);
    assert.deepEqual(
      hooks,
      enabled ? ["session_start", "before_provider_request"] : [],
    );
  });
}
