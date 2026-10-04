import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import type {
  ExtensionAPI,
  ExtensionToolContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { useAgentDir } from "../../test-utils/agent-dir.ts";
import subagentExtension, { registerSubagents } from "./index.ts";
import type { MuxAdapter } from "./mux.ts";

function environment(t: TestContext, env: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(env)) {
    const previous = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
    t.after(() => {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    });
  }
}

function registrations() {
  const tools: string[] = [];
  const commands: string[] = [];
  const hooks: string[] = [];
  const definitions = new Map<string, ToolDefinition>();
  const pi = {
    registerTool(tool: ToolDefinition) {
      tools.push(tool.name);
      definitions.set(tool.name, tool);
    },
    registerCommand(name: string) {
      commands.push(name);
    },
    on(event: string) {
      hooks.push(event);
    },
  } as unknown as ExtensionAPI;
  return { pi, tools, commands, hooks, definitions };
}

for (const [name, config, env] of [
  ["unconfigured mux", {}, { HERDR_ENV: "1" }],
  [
    "disabled workflow",
    { workflow: { enabled: false, subagent: { mux: "herdr" } } },
    { HERDR_ENV: "1" },
  ],
  [
    "disabled subagent",
    { workflow: { subagent: { enabled: false, mux: "herdr" } } },
    { HERDR_ENV: "1" },
  ],
  [
    "missing HERDR_ENV",
    { workflow: { subagent: { mux: "herdr" } } },
    { HERDR_ENV: undefined, HERDR_PANE_ID: "w1:p1", TMUX: "tmux" },
  ],
  [
    "invalid HERDR_ENV",
    { workflow: { subagent: { mux: "herdr" } } },
    { HERDR_ENV: "0" },
  ],
  [
    "worker recursion guard",
    { workflow: { subagent: { mux: "herdr" } } },
    { HERDR_ENV: "1", PI_KITS_SUBAGENT_WORKER: "1" },
  ],
] as const) {
  test(`subagent does not register capabilities: ${name}`, (t) => {
    useAgentDir(t, config);
    environment(t, { PI_KITS_SUBAGENT_WORKER: undefined, ...env });
    t.mock.method(globalThis, "setTimeout", () => {
      assert.fail("Disabled extensions must not start timers");
    });
    const capture = registrations();
    subagentExtension(capture.pi);
    assert.deepEqual(capture.tools, []);
    assert.deepEqual(capture.commands, []);
    assert.deepEqual(capture.hooks, []);
  });
}

test("configured Herdr enables tools with HERDR_ENV alone, without backend probing", (t) => {
  useAgentDir(t, { workflow: { subagent: { mux: "herdr" } } });
  environment(t, {
    HERDR_ENV: "1",
    HERDR_PANE_ID: undefined,
    HERDR_BIN_PATH: "/missing/herdr",
    PI_KITS_SUBAGENT_WORKER: undefined,
  });
  t.mock.method(globalThis, "setTimeout", () => {
    assert.fail("Loading must not start timers or workers");
  });
  const capture = registrations();
  subagentExtension(capture.pi);
  assert.deepEqual(capture.tools, [
    "subagent",
    "list_subagent_types",
    "get_subagent_result",
    "steer_subagent",
    "stop_subagent",
  ]);
  assert.deepEqual(capture.commands, ["subagent:views"]);
  assert.deepEqual(capture.hooks, ["session_start", "session_shutdown"]);
});

test("agent catalogue uses project overrides and unknown/disabled names never launch workers", async (t) => {
  const agentDir = useAgentDir(t);
  const cwd = join(agentDir, "project");
  const globalDir = join(agentDir, "agents");
  const projectDir = join(cwd, ".pi", "agents");
  mkdirSync(globalDir, { recursive: true });
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(globalDir, "review.md"), "Global secret instructions");
  writeFileSync(
    join(projectDir, "review.md"),
    "---\nenabled: false\n---\nProject secret instructions",
  );
  const adapter = new Proxy({} as MuxAdapter, {
    get() {
      assert.fail("Catalogues and invalid types must not touch the mux");
    },
  });
  const capture = registrations();
  registerSubagents(capture.pi, adapter);
  const ctx = { cwd, mode: "print" } as ExtensionToolContext;
  const list = capture.definitions.get("list_subagent_types");
  const spawn = capture.definitions.get("subagent");
  assert.ok(list && spawn);
  const result = await list.execute("call", {}, undefined, undefined, ctx);
  const catalog = result.structuredContent as {
    agents: { name: string; source: string; enabled: boolean }[];
  };
  assert.equal(catalog.agents.length, 1);
  assert.equal(catalog.agents[0].source, "project");
  assert.equal(catalog.agents[0].enabled, false);
  assert.ok(!JSON.stringify(result).includes("secret instructions"));
  for (const subagent_type of ["review", "unknown"]) {
    await assert.rejects(
      spawn.execute(
        "call",
        {
          subagent_type,
          prompt: "work",
          description: "test",
        },
        undefined,
        undefined,
        ctx,
      ),
      /disabled|Unknown subagent type/,
    );
  }
});

test("registration is lazy and does not invoke mux operations", () => {
  const adapter = new Proxy({} as MuxAdapter, {
    get() {
      assert.fail("No mux operation is allowed during registration");
    },
  });
  const capture = registrations();
  registerSubagents(capture.pi, adapter);
  assert.equal(capture.tools.length, 5);
});
