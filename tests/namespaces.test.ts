import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  ExtensionAPI,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import appendPrompts from "../extensions/pi-append-prompts/index.ts";
import ask from "../extensions/pi-ask/index.ts";
import canvasNote from "../extensions/pi-canvas-note/index.ts";
import handoff from "../extensions/pi-handoff/index.ts";
import open from "../extensions/pi-open/index.ts";
import outputViewer from "../extensions/pi-output-viewer/index.ts";
import serverTools from "../extensions/pi-server-tools/index.ts";
import type { Executor } from "../extensions/pi-subagent/execute/index.ts";
import { registerSubagents } from "../extensions/pi-subagent/index.ts";
import tokenMeter from "../extensions/pi-token-meter/index.ts";
import { useAgentDir } from "./helpers/agent-dir.ts";

type Entry = (pi: ExtensionAPI) => void | Promise<void>;
const extensions: Array<{
  name: string;
  register: Entry;
  tools: readonly string[];
  commands: readonly string[];
  exposure?: string;
}> = [
  {
    name: "pi-ask",
    register: ask,
    tools: ["ask_user_question"],
    commands: [],
    exposure: "model-only",
  },
  {
    name: "pi-canvas-note",
    register: canvasNote,
    tools: ["insert_page", "update_page", "insert_blocks", "update_blocks"],
    commands: ["canvas-note-server"],
    exposure: "deferred",
  },
  {
    name: "pi-handoff",
    register: handoff,
    tools: [],
    commands: ["handoff", "handoff-open"],
  },
  { name: "pi-open", register: open, tools: ["open"], commands: ["open"] },
  {
    name: "pi-output-viewer",
    register: outputViewer,
    tools: [],
    commands: ["output-viewer"],
  },
  {
    name: "pi-subagent",
    register: (pi) => registerSubagents(pi, {} as Executor),
    tools: ["subagent", "subagent_ctl"],
    commands: ["subagent:views"],
  },
  { name: "pi-token-meter", register: tokenMeter, tools: [], commands: [] },
  { name: "pi-server-tools", register: serverTools, tools: [], commands: [] },
  {
    name: "pi-append-prompts",
    register: appendPrompts,
    tools: [],
    commands: [],
  },
];

for (const extension of extensions) {
  test(`${extension.name}: tools use the directory namespace without renaming tools or commands`, async (t) => {
    useAgentDir(t);
    const tools: ToolDefinition[] = [];
    const commands: string[] = [];
    await extension.register({
      registerTool: (tool: ToolDefinition) => tools.push(tool),
      registerCommand: (name: string) => commands.push(name),
      registerMessageRenderer() {},
      registerShortcut() {},
      on() {},
    } as unknown as ExtensionAPI);
    assert.deepEqual(
      tools.map((tool) => tool.name),
      extension.tools,
    );
    assert.deepEqual(commands, extension.commands);
    for (const tool of tools) {
      assert.equal(tool.namespace?.name, extension.name, tool.name);
      assert.ok(tool.namespace?.description?.trim(), tool.name);
      assert.equal(tool.exposure, extension.exposure, tool.name);
    }
  });
}
