import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import open from "../extensions/pi-open/index.ts";
import preview from "../extensions/pi-output-viewer/index.ts";

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

test("disabled canonical extensions register no commands, tools, shortcuts or hooks", () => {
  writeFileSync(
    join(agentDir, "pi-kits.json"),
    '{"pi-open":{"enabled":false},"pi-output-viewer":{"enabled":false}}',
  );
  for (const entry of [open, preview]) {
    const h = host();
    entry(h.pi);
    assert.equal(h.commands.size, 0);
    assert.deepEqual(h.tools, []);
    assert.deepEqual(h.shortcuts, []);
    assert.equal(h.events.size, 0);
  }
});

test("directory-named settings control their own extension and ignore removed group switches", () => {
  for (const [entry, key] of [
    [open, "pi-open"],
    [preview, "pi-output-viewer"],
  ] as const) {
    writeFileSync(
      join(agentDir, "pi-kits.json"),
      JSON.stringify({ [key]: { enabled: false } }),
    );
    const disabled = host();
    entry(disabled.pi);
    assert.equal(disabled.commands.size, 0);
    assert.deepEqual(disabled.tools, []);
    assert.deepEqual(disabled.shortcuts, []);

    writeFileSync(
      join(agentDir, "pi-kits.json"),
      JSON.stringify({
        workspace: { enabled: false },
        [key]: { enabled: true },
      }),
    );
    const enabled = host();
    entry(enabled.pi);
    assert.equal(enabled.commands.size, 1);
  }
});

test("canonical feature switches disable only their own entry", () => {
  const cases = [
    [open, "pi-open"],
    [preview, "pi-output-viewer"],
  ] as const;
  for (const [entry, feature] of cases) {
    writeFileSync(
      join(agentDir, "pi-kits.json"),
      JSON.stringify({
        [feature]: { enabled: false },
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
