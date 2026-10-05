import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type {
  ExtensionAPI,
  ExtensionToolContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { useAgentDir } from "../../tests/helpers/agent-dir.ts";
import { parseAgentDefinition } from "./agents.ts";
import { registerSubagents } from "./index.ts";
import { type SpawnOptions, SubagentManager } from "./manager.ts";
import type { MuxAdapter } from "./mux/index.ts";
import { CodexRuntime } from "./runtime/codex/index.ts";

function definition(fields: string) {
  return parseAgentDefinition(
    `---\n${fields}\n---\nRole`,
    "/agents/test.md",
    "project",
  );
}

test("agent parser reads generic fields and retains nested runtime config without interpreting it", () => {
  assert.equal(definition("description: Test").runtime, undefined);
  const fields = "runtime: codex\nmodel: test-model\nthinking: high";
  const baseline = definition(fields);
  assert.equal(baseline.runtime, "codex");
  assert.equal(baseline.model, "test-model");
  assert.equal(baseline.thinking, "high");
  assert.equal(baseline.runtimeConfig, undefined);
  assert.deepEqual(
    definition(
      `${fields}\nruntime_config:\n  tools: [read, read]\n  disallowed_tools: write\n  prompt_mode: append`,
    ).runtimeConfig,
    {
      tools: ["read", "read"],
      disallowed_tools: "write",
      prompt_mode: "append",
    },
  );
  for (const ignored of [
    "codex: false",
    "codex: {}",
    "codex:\n  sandbox: 1",
    "codex:\n  approval_policy: automatic",
    "codex:\n  toolz: []",
    "sandbox: danger-full-access",
    "approval_policy: invalid",
    "future_runtime_options: { arbitrary: [1, false] }",
  ]) {
    assert.deepEqual(definition(`${fields}\n${ignored}`), baseline);
  }
  assert.throws(() => definition("runtime: false"), /Invalid agent/);
});

test("runtime names are validated by the registry, not hardcoded in the parser", async () => {
  const agent = definition("runtime: future-runtime");
  assert.equal(agent.runtime, "future-runtime");
  const manager = new SubagentManager({} as MuxAdapter);
  try {
    assert.throws(
      () =>
        manager.spawn({
          agent,
          cwd: "/tmp",
          prompt: "Task",
          description: "Test",
        }),
      /Unknown subagent runtime: future-runtime/,
    );
    assert.equal(manager.list().length, 0);
  } finally {
    await manager.close();
  }
});

test("Codex ignores Pi-owned runtime fields, including values invalid for Pi", () => {
  const runtime = new CodexRuntime();
  for (const prefix of ["", "runtime: codex\n"]) {
    for (const fields of [
      "prompt_mode: replace",
      "prompt_mode: append",
      "prompt_mode: [false]",
      "tools: false",
      "disallowed_tools: null",
      "inherit_context: invalid",
      "future_option: { arbitrary: [false] }",
    ]) {
      const agent = definition(`${prefix}runtime_config:\n  ${fields}`);
      assert.deepEqual(runtime.parseConfig(agent.runtimeConfig ?? {}), {
        runtime_args: [],
      });
      assert.doesNotThrow(() =>
        runtime.validate({ id: "test", cwd: "/tmp", agent }),
      );
    }
  }
});

test("Codex does not inherit Pi model/thinking or read parent context, and frontmatter runtime wins", async (t) => {
  const agentDir = useAgentDir(t);
  const cwd = join(agentDir, "project");
  mkdirSync(join(cwd, ".pi", "agent", "agents"), { recursive: true });
  writeFileSync(
    join(cwd, ".pi", "agent", "agents", "codex.md"),
    "---\nruntime: codex\n---\nRole",
  );
  const tools = new Map<string, ToolDefinition>();
  const pi = {
    registerTool(tool: ToolDefinition) {
      tools.set(tool.name, tool);
    },
    registerMessageRenderer() {},
    registerCommand() {},
    on() {},
    getThinkingLevel() {
      return "max";
    },
  } as unknown as ExtensionAPI;
  registerSubagents(pi, {} as MuxAdapter);
  let latest: SpawnOptions | undefined;
  t.mock.method(SubagentManager.prototype, "spawn", (options: SpawnOptions) => {
    latest = options;
    return { id: "child", status: "queued", description: options.description };
  });
  const ctx = {
    cwd,
    mode: "print",
    model: { provider: "pi-provider", id: "pi-model" },
    sessionManager: {
      getBranch() {
        assert.fail("Codex must never inspect parent history");
      },
    },
  } as unknown as ExtensionToolContext;
  const tool = tools.get("subagent");
  assert.ok(tool);
  await tool.execute(
    "call",
    { runtime: "codex", prompt: "Task", description: "Test" },
    undefined,
    undefined,
    ctx,
  );
  assert.equal(latest?.runtime, "codex");
  assert.equal(latest?.model, undefined);
  assert.equal(latest?.thinking, undefined);
  await tool.execute(
    "call",
    {
      subagent_type: "codex",
      runtime: "pi",
      model: "codex-model",
      thinking: "high",
      prompt: "Task",
      description: "Test",
    },
    undefined,
    undefined,
    ctx,
  );
  assert.equal(latest?.runtime, "codex");
  assert.equal(latest?.model, "codex-model");
  assert.equal(latest?.thinking, "high");
  await tool.execute(
    "call",
    {
      runtime: "codex",
      runtime_config: { inherit_context: true },
      prompt: "Task",
      description: "Test",
    },
    undefined,
    undefined,
    ctx,
  );
  assert.deepEqual(latest?.runtimeParams, { inherit_context: true });
  assert.equal(latest?.context, ctx.sessionManager);
  assert.equal(latest?.parentSession, undefined);
  await tool.execute(
    "call",
    { prompt: "Task", description: "Test" },
    undefined,
    undefined,
    ctx,
  );
  assert.equal(latest?.runtime, "pi");
  assert.equal(latest?.model, "pi-provider/pi-model");
  assert.equal(latest?.thinking, "max");
});
