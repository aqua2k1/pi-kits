import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
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
  const pi = {
    registerTool(tool: { name: string }) {
      tools.push(tool.name);
    },
    registerCommand(name: string) {
      commands.push(name);
    },
    on(event: string) {
      hooks.push(event);
    },
  } as unknown as ExtensionAPI;
  return { pi, tools, commands, hooks };
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
    "get_subagent_result",
    "steer_subagent",
    "stop_subagent",
  ]);
  assert.deepEqual(capture.commands, ["subagent:views"]);
  assert.deepEqual(capture.hooks, ["session_start", "session_shutdown"]);
});

test("registration is lazy and does not invoke mux operations", () => {
  const adapter = new Proxy({} as MuxAdapter, {
    get() {
      assert.fail("No mux operation is allowed during registration");
    },
  });
  const capture = registrations();
  registerSubagents(capture.pi, adapter);
  assert.equal(capture.tools.length, 4);
});
