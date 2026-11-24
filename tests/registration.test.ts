import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import open from "../extensions/pi-open/index.ts";
import preview from "../extensions/pi-output-viewer/index.ts";

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
    [open, ["open"]],
    [preview, ["output-viewer"]],
  ] as const;
  for (const [entry, names] of expected) {
    const h = host();
    entry(h.pi);
    assert.deepEqual([...h.commands.keys()], [...names]);
    assert.deepEqual(h.tools, entry === open ? ["open"] : []);
    assert.deepEqual(h.shortcuts, entry === preview ? ["alt+p"] : []);
  }
});
