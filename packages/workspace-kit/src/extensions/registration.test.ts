import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import contextPreview from "./context-preview.ts";
import open from "./open.ts";
import preview from "./preview.ts";
import terminal from "./terminal.ts";

type Command = Parameters<ExtensionAPI["registerCommand"]>[1];
type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
function host() {
  const commands = new Map<string, Command>();
  const tools: string[] = [];
  const shortcuts: string[] = [];
  const events = new Map<string, Handler>();
  const pi = {
    registerCommand: (name: string, command: Command) =>
      commands.set(name, command),
    registerTool: (tool: { name: string }) => tools.push(tool.name),
    registerShortcut: (name: string) => shortcuts.push(name),
    on: (name: string, handler: Handler) => events.set(name, handler),
  } as unknown as ExtensionAPI;
  return { pi, commands, tools, shortcuts, events };
}

test("workspace entries keep public names without implicit sibling registration", () => {
  const expected = [
    [terminal, ["vim", "lg", "fm"]],
    [open, ["open"]],
    [preview, ["preview"]],
    [contextPreview, ["context-preview"]],
  ] as const;
  for (const [entry, names] of expected) {
    const h = host();
    entry(h.pi);
    assert.deepEqual([...h.commands.keys()], [...names]);
    assert.deepEqual(h.tools, entry === open ? ["open"] : []);
    assert.deepEqual(h.shortcuts, entry === preview ? ["alt+p"] : []);
  }
});

test("request caching stays opt-in and resets at session start", async () => {
  const h = host();
  contextPreview(h.pi);
  const notifications: string[] = [];
  const ctx = {
    mode: "tui",
    ui: { notify: (message: string) => notifications.push(message) },
  } as unknown as ExtensionCommandContext;
  const command = h.commands.get("context-preview");
  assert.ok(command);
  await command.handler("status", ctx);
  assert.match(notifications.pop() ?? "", /已禁用/);
  await command.handler("start", ctx);
  await command.handler("status", ctx);
  assert.match(notifications.pop() ?? "", /已启用/);
  await h.events.get("session_start")?.({}, ctx);
  await command.handler("status", ctx);
  assert.match(notifications.pop() ?? "", /已禁用/);
});

test("context preview rejects RPC before interacting with a terminal", async () => {
  const h = host();
  contextPreview(h.pi);
  const notifications: string[] = [];
  await h.commands.get("context-preview")?.handler("", {
    mode: "rpc",
    ui: { notify: (message: string) => notifications.push(message) },
  } as unknown as ExtensionCommandContext);
  assert.deepEqual(notifications, ["/context-preview 需要交互式终端"]);
});
