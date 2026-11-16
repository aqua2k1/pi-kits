import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { test } from "node:test";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { useAgentDir } from "../../tests/helpers/agent-dir.ts";
import previewExtension from "./index.ts";

for (const [config, expectedEditor] of [
  [{ "pi-output-viewer": { editor: "canonical-editor" } }, "canonical-editor"],
  [{ terminal: { editor: "ignored-editor" } }, "nvim"],
  [
    {
      workspace: { terminal: { editor: "ignored-editor" } },
      terminal: { editor: "also-ignored" },
      "pi-output-viewer": {},
    },
    "nvim",
  ],
] as const) {
  for (const latestOnly of [false, true]) {
    test(`editor ${expectedEditor} is used by ${latestOnly ? "shortcut" : "command"}: ${JSON.stringify(config)}`, async (t) => {
      const cwd = useAgentDir(t, config);
      let command: Parameters<ExtensionAPI["registerCommand"]>[1] | undefined;
      let shortcut: Parameters<ExtensionAPI["registerShortcut"]>[1] | undefined;
      previewExtension({
        registerCommand(_name, definition) {
          command = definition;
        },
        registerShortcut(_key, definition) {
          shortcut = definition;
        },
      } as ExtensionAPI);
      const files: string[] = [];
      t.mock.method(
        childProcess,
        "spawnSync",
        (editor: string, args: string[]) => {
          assert.equal(editor, expectedEditor);
          assert.equal(args[0], "-R");
          assert.equal(readFileSync(args[1], "utf8"), "Reply\n");
          files.push(args[1]);
          return { status: 0, signal: null };
        },
      );
      syncBuiltinESMExports();
      t.after(() => {
        t.mock.restoreAll();
        syncBuiltinESMExports();
      });
      const ctx = {
        cwd,
        mode: "tui",
        isIdle: () => true,
        sessionManager: {
          getSessionId: () => "editor-test",
          getBranch: () => [
            {
              type: "message",
              message: {
                role: "assistant",
                content: [{ type: "text", text: "Reply" }],
              },
            },
          ],
        },
        ui: {
          notify: () => assert.fail("Unexpected notification"),
          select: async (_title: string, rows: string[]) => rows[0],
          custom: async (
            factory: Parameters<ExtensionUIContext["custom"]>[0],
          ) => {
            let result: unknown;
            factory(
              { stop() {}, start() {}, requestRender() {} } as Parameters<
                typeof factory
              >[0],
              {} as Parameters<typeof factory>[1],
              {} as Parameters<typeof factory>[2],
              (value) => {
                result = value;
              },
            );
            return result;
          },
        },
      } as unknown as ExtensionCommandContext;
      assert.ok(command && shortcut);
      if (latestOnly) await shortcut.handler(ctx);
      else await command.handler("", ctx);
      assert.equal(files.length, 1);
      assert.equal(existsSync(files[0]), false);
    });
  }
}

for (const [config, enabled] of [
  [undefined, true],
  [{ "pi-output-viewer": { enabled: false } }, false],
  [{ "pi-output-viewer": { enabled: true } }, true],
  // Old group and feature keys are unknown raw fields, not aliases.
  [{ workspace: { enabled: false } }, true],
  [{ workspace: { preview: { enabled: false } } }, true],
  [{ preview: { enabled: false } }, true],
  [{ preview: { enabled: false }, "pi-output-viewer": {} }, true],
  [
    { preview: { enabled: true }, "pi-output-viewer": { enabled: false } },
    false,
  ],
] as const) {
  test(`output-viewer factory respects configuration ${JSON.stringify(config)}`, (t) => {
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
    assert.deepEqual(commands, enabled ? ["output-viewer"] : []);
    assert.deepEqual(shortcuts, enabled ? ["alt+p"] : []);
  });
}
