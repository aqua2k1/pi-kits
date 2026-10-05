import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import {
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionToolContext,
  SessionManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import { useAgentDir } from "../../tests/helpers/agent-dir.ts";
import subagentExtension, { registerSubagents } from "./index.ts";
import {
  type ResumeOptions,
  type SpawnOptions,
  SubagentManager,
} from "./manager.ts";
import type { MuxAdapter } from "./mux/index.ts";

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
  const hookHandlers = new Map<string, () => void | Promise<void>>();
  const definitions = new Map<string, ToolDefinition>();
  const commandHandlers = new Map<
    string,
    Parameters<ExtensionAPI["registerCommand"]>[1]
  >();
  const pi = {
    registerMessageRenderer() {},
    registerTool(tool: ToolDefinition) {
      tools.push(tool.name);
      definitions.set(tool.name, tool);
    },
    registerCommand(
      name: string,
      definition: Parameters<ExtensionAPI["registerCommand"]>[1],
    ) {
      commands.push(name);
      commandHandlers.set(name, definition);
    },
    on(event: string, handler: () => void | Promise<void>) {
      hooks.push(event);
      hookHandlers.set(event, handler);
    },
  } as unknown as ExtensionAPI;
  return {
    pi,
    tools,
    commands,
    hooks,
    hookHandlers,
    definitions,
    commandHandlers,
  };
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
    "disabled top-level subagent",
    { subagent: { enabled: false, mux: "herdr" } },
    { HERDR_ENV: "1" },
  ],
  [
    "top-level missing HERDR_ENV",
    { subagent: { mux: "herdr" } },
    { HERDR_ENV: undefined },
  ],
  [
    "top-level worker recursion guard",
    { subagent: { mux: "herdr" } },
    { HERDR_ENV: "1", PI_KITS_SUBAGENT_WORKER: "1" },
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

for (const config of [
  { workflow: { subagent: { mux: "herdr" } } },
  { subagent: { mux: "herdr" } },
]) {
  test(`configured Herdr enables tools with HERDR_ENV alone, without backend probing ${JSON.stringify(config)}`, (t) => {
    useAgentDir(t, config);
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
      "resume_subagent",
      "list_subagent_types",
      "get_subagent_result",
      "steer_subagent",
      "stop_subagent",
    ]);
    assert.deepEqual(capture.commands, ["subagent:views"]);
    assert.deepEqual(capture.hooks, ["session_start", "session_shutdown"]);
  });
}

for (const failures of [1, 3]) {
  test(`shutdown retains its manager through ${failures} cleanup failures`, async (t) => {
    const capture = registrations();
    const managers: SubagentManager[] = [];
    const closed: SubagentManager[] = [];
    t.mock.method(
      SubagentManager.prototype,
      "result",
      async function (this: SubagentManager) {
        managers.push(this);
        return {
          id: "owned",
          description: "Task",
          status: "completed" as const,
        };
      },
    );
    t.mock.method(
      SubagentManager.prototype,
      "close",
      async function (this: SubagentManager) {
        closed.push(this);
        if (closed.length <= failures) throw new Error("Cleanup unavailable");
      },
    );
    registerSubagents(capture.pi, {} as MuxAdapter);
    const tool = capture.definitions.get("get_subagent_result");
    const shutdown = capture.hookHandlers.get("session_shutdown");
    assert.ok(tool && shutdown);
    const read = () =>
      tool.execute("call", { agent_id: "owned" }, undefined, undefined, {
        mode: "print",
      } as ExtensionToolContext);
    await read();
    const closing = shutdown();
    assert.equal(shutdown(), closing);
    await assert.rejects(read(), /shutting down/);
    if (failures === 3) {
      await assert.rejects(Promise.resolve(closing), /Cleanup unavailable/);
      assert.equal(closed.length, 3, "shutdown retries are bounded");
      await read();
      assert.equal(managers.at(-1), managers[0]);
      await shutdown();
    } else {
      await closing;
    }
    assert.ok(closed.every((current) => current === managers[0]));
    await read();
    assert.notEqual(managers.at(-1), managers[0]);
    await shutdown();
  });
}

test("tool prompts and configuration schemas stay runtime-neutral", () => {
  const capture = registrations();
  registerSubagents(capture.pi, {} as MuxAdapter);
  const properties = (tool: ToolDefinition) =>
    (
      tool.parameters as unknown as {
        properties: Record<string, { description: string }>;
      }
    ).properties;
  for (const tool of capture.definitions.values()) {
    assert.doesNotMatch(tool.description, /\b(?:Pi|Codex|Herdr)\b/i);
    for (const [name, schema] of Object.entries(properties(tool))) {
      assert.doesNotMatch(schema.description, /\b(?:Pi|Codex|Herdr)\b/i);
      assert.ok(
        schema.description?.trim(),
        `${tool.name}.${name} needs guidance`,
      );
    }
  }
  const spawn = capture.definitions.get("subagent");
  assert.ok(spawn);
  assert.match(spawn.description, /configuration takes precedence/);
  assert.match(properties(spawn).prompt.description, /not a system prompt/);
  assert.match(properties(spawn).model.description, /selected runtime/);
  const steer = capture.definitions.get("steer_subagent");
  assert.ok(steer);
  assert.match(steer.description, /running task/);
  assert.ok(!steer.description.includes("after its current tools"));
});

test("opaque runtime configuration is forwarded on spawn and resume", async (t) => {
  const cwd = useAgentDir(t);
  const capture = registrations();
  const spawned: SpawnOptions[] = [];
  const resumed: ResumeOptions[] = [];
  t.mock.method(SubagentManager.prototype, "spawn", (options: SpawnOptions) => {
    spawned.push(options);
    return { id: "review-id", description: "Review", status: "queued" };
  });
  t.mock.method(
    SubagentManager.prototype,
    "resume",
    (_id: string, options: ResumeOptions) => {
      resumed.push(options);
      return { id: "review-id", description: "Review", status: "queued" };
    },
  );
  t.mock.method(
    SubagentManager.prototype,
    "backgroundPreference",
    () => undefined,
  );
  registerSubagents(capture.pi, {} as MuxAdapter);
  const context = { cwd, mode: "print", hasUI: false } as ExtensionToolContext;
  const target = { type: "baseBranch", branch: "main" };
  const spawn = capture.definitions.get("subagent");
  const resume = capture.definitions.get("resume_subagent");
  assert.ok(spawn && resume);
  for (const tool of [spawn, resume]) {
    const properties = (
      tool.parameters as unknown as {
        properties: Record<string, object>;
      }
    ).properties;
    assert.equal(properties.review_target, undefined);
    const required =
      tool.name === "subagent"
        ? { description: "Future task" }
        : { agent_id: "future-id" };
    assert.equal(
      Value.Check(tool.parameters, {
        ...required,
        runtime_config: { future_option: { native: true } },
      }),
      true,
    );
    assert.equal(
      Value.Check(tool.parameters, {
        ...required,
        review_target: target,
      }),
      true,
    );
    assert.equal(
      Value.Check(properties.runtime_config, {
        future_option: { native: true },
      }),
      true,
    );
    for (const value of [null, [], "native", false]) {
      assert.equal(Value.Check(properties.runtime_config, value), false);
    }
  }
  await spawn.execute(
    "call",
    {
      runtime: "codex",
      description: "Review",
      runtime_config: { runtime_args: "review", review_target: target },
    },
    undefined,
    undefined,
    context,
  );
  await resume.execute(
    "call",
    { agent_id: "review-id", runtime_config: { review_target: target } },
    undefined,
    undefined,
    context,
  );
  assert.equal(spawned[0].prompt, "");
  assert.deepEqual(spawned[0].runtimeParams, {
    runtime_args: "review",
    review_target: target,
  });
  assert.equal(resumed[0].prompt, "");
  assert.deepEqual(resumed[0].runtimeParams, { review_target: target });
  await capture.hookHandlers.get("session_shutdown")?.();
});

test("agent catalogue uses project overrides and unknown/disabled names never launch workers", async (t) => {
  const agentDir = useAgentDir(t);
  const cwd = join(agentDir, "project");
  const globalDir = join(agentDir, "agents");
  const projectDir = join(cwd, ".pi", "agent", "agents");
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

test("context and inheritance options remain opaque to the tool entry point", async (t) => {
  const agentDir = useAgentDir(t);
  const cwd = join(agentDir, "project");
  const agents = join(cwd, ".pi", "agent", "agents");
  mkdirSync(agents, { recursive: true });
  for (const inherit_context of [true, false]) {
    writeFileSync(
      join(agents, `${inherit_context ? "inherit" : "fresh"}.md`),
      `---\nruntime_config:\n  inherit_context: ${inherit_context}\n---\nRole`,
    );
  }
  const session = SessionManager.inMemory(cwd);
  t.mock.method(session, "getBranch", () => {
    assert.fail("Only the selected runtime may read parent history");
  });
  t.mock.method(SubagentManager.prototype, "runtimeCapabilities", () => {
    assert.fail("Tool entry must not decide how a runtime uses host context");
  });
  let latest: SpawnOptions | undefined;
  t.mock.method(SubagentManager.prototype, "spawn", (options: SpawnOptions) => {
    latest = options;
    return { id: "child", description: options.description, status: "queued" };
  });
  const capture = registrations();
  capture.pi.getThinkingLevel = () => "low";
  registerSubagents(capture.pi, {} as MuxAdapter);
  const spawn = capture.definitions.get("subagent");
  assert.ok(spawn);
  const ctx = {
    mode: "print",
    cwd,
    sessionManager: session,
  } as unknown as ExtensionToolContext;
  for (const [subagent_type, inherit_context] of [
    ["inherit", false],
    ["fresh", true],
    [undefined, true],
    [undefined, undefined],
  ] as const) {
    const runtime_config =
      inherit_context === undefined ? undefined : { inherit_context };
    await spawn.execute(
      "call",
      { subagent_type, runtime_config, prompt: "Task", description: "Test" },
      undefined,
      undefined,
      ctx,
    );
    assert.equal(latest?.context, session);
    assert.equal(latest?.parentSession, undefined);
    assert.deepEqual(latest?.runtimeParams, runtime_config);
    if (subagent_type) {
      assert.equal(
        latest?.agent?.runtimeConfig?.inherit_context,
        subagent_type === "inherit",
      );
    }
  }
  await spawn.execute(
    "call",
    {
      runtime: "future-runtime",
      inherit_context: true,
      tools: false,
      runtime_config: { native_context: "custom-format" },
      prompt: "Task",
      description: "Test",
    },
    undefined,
    undefined,
    ctx,
  );
  assert.equal(latest?.context, session);
  assert.deepEqual(latest?.runtimeParams, { native_context: "custom-format" });
  assert.equal(
    Value.Check(spawn.parameters, {
      inherit_context: true,
      prompt: "Task",
      description: "Legacy top-level option",
    }),
    true,
  );
});

test("resume tool respects retained background preferences and aborted callers never enqueue work", async (t) => {
  const capture = registrations();
  const adapter = new Proxy({} as MuxAdapter, {
    get() {
      assert.fail("Tool presentation must not spawn a process");
    },
  });
  registerSubagents(capture.pi, adapter);
  const tool = capture.definitions.get("resume_subagent");
  assert.ok(tool);
  let preference: boolean | undefined;
  let resumed = 0;
  let waited = 0;
  t.mock.method(
    SubagentManager.prototype,
    "backgroundPreference",
    () => preference,
  );
  t.mock.method(
    SubagentManager.prototype,
    "resume",
    (id: string, options: ResumeOptions) => {
      resumed += 1;
      assert.equal(id, "same-id");
      assert.equal(options.prompt, "Continue");
      return { id, description: "Original task", status: "queued", round: 2 };
    },
  );
  t.mock.method(
    SubagentManager.prototype,
    "result",
    async (id: string, wait: boolean) => {
      assert.equal(wait, true);
      waited += 1;
      return {
        id,
        description: "Original task",
        status: "completed",
        round: 2,
      };
    },
  );
  const ctx = { mode: "print" } as ExtensionToolContext;
  for (const [configured, requested, expectedWait] of [
    [undefined, undefined, false],
    [undefined, false, true],
    [false, true, true],
    [true, false, false],
  ] as const) {
    preference = configured;
    const before = waited;
    const result = await tool.execute(
      "call",
      {
        agent_id: "same-id",
        prompt: "Continue",
        run_in_background: requested,
      },
      undefined,
      undefined,
      ctx,
    );
    assert.equal(waited - before, expectedWait ? 1 : 0);
    assert.equal(
      (result.details as { status: string }).status,
      expectedWait ? "completed" : "queued",
    );
  }
  const signal = AbortSignal.abort(new Error("Already canceled"));
  await assert.rejects(
    tool.execute(
      "call",
      { agent_id: "same-id", prompt: "Continue" },
      signal,
      undefined,
      ctx,
    ),
    /Already canceled/,
  );
  assert.equal(resumed, 4);
});

test("views command confirms deletion before execution and reports failures", async (t) => {
  const capture = registrations();
  registerSubagents(capture.pi, {} as MuxAdapter);
  const command = capture.commandHandlers.get("subagent:views");
  assert.ok(command);
  const order: string[] = [];
  let confirmed = false;
  let fail = false;
  t.mock.method(SubagentManager.prototype, "get", (id: string) => ({
    id,
    description: "My task",
    status: "queued",
  }));
  t.mock.method(SubagentManager.prototype, "remove", async (id: string) => {
    order.push(`remove:${id}`);
    if (fail) throw new Error("Cleanup failed");
  });
  const ctx = {
    mode: "tui",
    ui: {
      setWidget() {},
      setStatus() {},
      async confirm(title: string, message: string) {
        order.push("confirm");
        assert.match(title, /Delete subagent/);
        assert.match(message, /full-id/);
        assert.match(message, /Session files are retained/);
        return confirmed;
      },
      notify(message: string) {
        order.push(message);
      },
    },
  } as unknown as ExtensionCommandContext;
  await command.handler("full-id delete", ctx);
  assert.deepEqual(order, ["confirm"]);
  order.length = 0;
  confirmed = true;
  await command.handler("full-id delete", ctx);
  assert.deepEqual(order, ["confirm", "remove:full-id"]);
  order.length = 0;
  fail = true;
  await command.handler("full-id delete", ctx);
  assert.deepEqual(order, ["confirm", "remove:full-id", "Cleanup failed"]);
  order.length = 0;
  await command.handler("full-id invalid", ctx);
  assert.match(order[0], /View action/);
});

test("views copy command writes the full ID through Pi clipboard support", async (t) => {
  if (process.platform !== "linux") return;
  environment(t, {
    DISPLAY: undefined,
    WAYLAND_DISPLAY: undefined,
    TERMUX_VERSION: undefined,
  });
  const capture = registrations();
  registerSubagents(capture.pi, {} as MuxAdapter);
  const command = capture.commandHandlers.get("subagent:views");
  assert.ok(command);
  const id = "12345678-full-subagent-id";
  t.mock.method(SubagentManager.prototype, "get", () => ({
    id,
    description: "Task",
    status: "queued",
  }));
  const output: string[] = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  const write = t.mock.method(
    process.stdout,
    "write",
    (...args: Parameters<typeof process.stdout.write>) => {
      const [chunk] = args;
      if (typeof chunk === "string" && chunk.startsWith("\x1b]52;c;")) {
        output.push(chunk);
        return true;
      }
      return originalWrite(...args);
    },
  );
  const notices: string[] = [];
  const ctx = {
    mode: "tui",
    ui: {
      setWidget() {},
      setStatus() {},
      notify(message: string) {
        notices.push(message);
      },
    },
  } as unknown as ExtensionCommandContext;
  await command.handler(`${id} copy`, ctx);
  write.mock.restore();
  assert.ok(
    output.includes(`\x1b]52;c;${Buffer.from(id).toString("base64")}\x07`),
  );
  assert.deepEqual(notices, ["Copied subagent ID."]);
});

test("registration is lazy and does not invoke mux operations", () => {
  const adapter = new Proxy({} as MuxAdapter, {
    get() {
      assert.fail("No mux operation is allowed during registration");
    },
  });
  const capture = registrations();
  registerSubagents(capture.pi, adapter);
  assert.equal(capture.tools.length, 6);
  for (const name of [
    "subagent",
    "resume_subagent",
    "get_subagent_result",
    "steer_subagent",
    "stop_subagent",
  ]) {
    assert.equal(typeof capture.definitions.get(name)?.renderCall, "function");
    assert.equal(
      typeof capture.definitions.get(name)?.renderResult,
      "function",
    );
  }
});
