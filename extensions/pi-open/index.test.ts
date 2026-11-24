import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import openExtension from "./index.ts";

test("open factory registers command and namespaced tool", () => {
  const commands: string[] = [];
  const tools: string[] = [];
  openExtension({
    registerCommand(name: string) {
      commands.push(name);
    },
    registerTool(tool: {
      name: string;
      namespace?: { name: string };
      exposure?: string;
    }) {
      assert.equal(tool.namespace?.name, "pi-open");
      assert.equal(tool.exposure, undefined);
      tools.push(tool.name);
    },
  } as unknown as ExtensionAPI);
  assert.deepEqual(commands, ["open"]);
  assert.deepEqual(tools, ["open"]);
});
