import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import contextPreview from "./context-preview.ts";
import open from "./open.ts";
import preview from "./preview.ts";
import terminal from "./terminal.ts";

let agentDir: string;
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
before(() => {
  agentDir = mkdtempSync(join(tmpdir(), "pi-kits-workspace-"));
  process.env.PI_CODING_AGENT_DIR = agentDir;
});
beforeEach(() => writeFileSync(join(agentDir, "pi-kits.json"), "{}"));
after(() => {
  rmSync(agentDir, { recursive: true, force: true });
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
});

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

test("disabled workspace registers no commands, tools, shortcuts or hooks", () => {
  writeFileSync(
    join(agentDir, "pi-kits.json"),
    '{"workspace":{"enabled":false}}',
  );
  for (const entry of [terminal, open, preview, contextPreview]) {
    const h = host();
    entry(h.pi);
    assert.equal(h.commands.size, 0);
    assert.deepEqual(h.tools, []);
    assert.deepEqual(h.shortcuts, []);
    assert.equal(h.events.size, 0);
  }
});

test("workspace feature switches disable only their own entry", () => {
  const cases = [
    [terminal, "terminal"],
    [open, "open"],
    [preview, "preview"],
    [contextPreview, "contextPreview"],
  ] as const;
  for (const [entry, feature] of cases) {
    writeFileSync(
      join(agentDir, "pi-kits.json"),
      JSON.stringify({
        workspace: { [feature]: { enabled: false } },
      }),
    );
    const h = host();
    entry(h.pi);
    assert.equal(h.commands.size, 0);
    assert.equal(h.events.size, 0);
    assert.deepEqual(h.tools, []);
    assert.deepEqual(h.shortcuts, []);
  }
});

test("terminal commands use configured executables", async () => {
  writeFileSync(
    join(agentDir, "pi-kits.json"),
    JSON.stringify({
      workspace: {
        terminal: {
          editor: "configured-editor",
          gitUI: "configured-git",
          fileManager: "configured-manager",
        },
      },
    }),
  );
  const h = host();
  terminal(h.pi);
  const messages: string[] = [];
  const ctx = {
    mode: "tui",
    ui: {
      custom: async () => {
        throw new Error("fixture UI");
      },
      notify: (message: string) => messages.push(message),
    },
  } as unknown as ExtensionCommandContext;
  for (const command of ["vim", "lg", "fm"]) {
    await h.commands.get(command)?.handler("", ctx);
  }
  assert.deepEqual(messages, [
    "Failed to launch configured-editor: fixture UI",
    "Failed to launch configured-git: fixture UI",
    "Failed to launch configured-manager: fixture UI",
  ]);
});
