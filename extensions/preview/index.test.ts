import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { useAgentDir } from "../../tests/helpers/agent-dir.ts";
import previewExtension from "./index.ts";

for (const [config, enabled] of [
  [undefined, true],
  [{ workspace: { enabled: false } }, false],
  [{ workspace: { preview: { enabled: false } } }, false],
  [{ workspace: { preview: { enabled: true } } }, true],
  [{ preview: { enabled: false } }, false],
  [{ preview: { enabled: true } }, true],
] as const) {
  test(`preview factory respects configuration ${JSON.stringify(config)}`, (t) => {
    useAgentDir(t, config);
    const commands: string[] = [];
    const shortcuts: string[] = [];
    previewExtension({
      registerCommand(name: string) {
        commands.push(name);
      },
      registerShortcut(shortcut: string) {
        shortcuts.push(shortcut);
      },
    } as unknown as ExtensionAPI);
    assert.deepEqual(commands, enabled ? ["preview"] : []);
    assert.deepEqual(shortcuts, enabled ? ["alt+p"] : []);
  });
}
