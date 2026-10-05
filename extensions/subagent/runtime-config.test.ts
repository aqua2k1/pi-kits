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
import type { MuxAdapter } from "./mux.ts";

function definition(fields: string) {
  return parseAgentDefinition(
    `---\n${fields}\n---\nRole`,
    "/agents/test.md",
    "project",
  );
}

test("agent parser reads runtime/model/thinking and ignores unsupported fields", () => {
  assert.equal(definition("description: Test").runtime, undefined);
  const fields = "runtime: codex\nmodel: test-model\nthinking: high";
  const baseline = definition(fields);
  assert.equal(baseline.runtime, "codex");
  assert.equal(baseline.model, "test-model");
  assert.equal(baseline.thinking, "high");
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
  assert.deepEqual(
    definition("runtime: pi\ncodex: false"),
    definition("runtime: pi"),
  );
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

test("Codex rejects explicit prompt modes before worker creation", async () => {
  const manager = new SubagentManager({} as MuxAdapter);
  try {
    for (const runtime of ["", "runtime: codex\n"]) {
      for (const mode of ["replace", "append"]) {
        assert.throws(
          () =>
            manager.spawn({
              agent: definition(`${runtime}prompt_mode: ${mode}`),
              runtime: "codex",
              cwd: "/tmp",
              prompt: "Task",
              description: "Test",
            }),
          /prompt_mode.*Pi runtime/,
        );
      }
    }
    assert.equal(manager.list().length, 0);
  } finally {
    await manager.close();
  }
});

test("Codex does not inherit Pi model/thinking or read parent context, and frontmatter runtime wins", async (t) => {
  const agentDir = useAgentDir(t);
  const cwd = join(agentDir, "project");
  mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
  writeFileSync(
    join(cwd, ".pi", "agents", "codex.md"),
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
  await assert.rejects(
    tool.execute(
      "call",
      {
        runtime: "codex",
        inherit_context: true,
        prompt: "Task",
        description: "Test",
      },
      undefined,
      undefined,
      ctx,
    ),
    /Cross-runtime context cloning/,
  );
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
