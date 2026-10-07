import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { parseAgentDefinition } from "./agents.ts";
import { SubagentManager } from "./manager.ts";
import type { MuxAdapter, TerminalHandle } from "./mux/index.ts";
import { RuntimeTaskRejectedError } from "./runtime/errors.ts";
import type {
  AgentRuntime,
  RuntimeCommand,
  RuntimeHost,
  RuntimeId,
  RuntimeOptions,
  RuntimeSession,
} from "./runtime/index.ts";

const task = { prompt: "Inspect", description: "Inspect files", cwd: "/tmp" };

function deferred() {
  let resolve = () => {};
  let reject = (_error: Error) => {};
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

async function until(check: () => boolean) {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await delay(5);
  }
  assert.fail("Condition did not become true");
}

function harness(id: RuntimeId = "codex") {
  const capabilities = {
    nativeClone: false,
    steer: true,
    retainedSession: true,
    concurrentNativeInput: false,
  };
  const sessions: FakeSession[] = [];
  const validated: RuntimeOptions[] = [];
  const opened: string[] = [];
  const closedViews: string[] = [];
  const mux: MuxAdapter = {
    check_env: () => true,
    start: async () => assert.fail("Only the runtime may start execution"),
    inspect: async () => assert.fail("Manager must inspect the runtime"),
    destroy: async () => assert.fail("Only the runtime may destroy execution"),
    open_view: async ({ terminal }) => {
      opened.push(terminal.id);
      return { id: `view-${terminal.id}` };
    },
    inspect_view: async () => ({ alive: true }),
    focus_view: async () => {},
    close_view: async (view) => {
      closedViews.push(view.id);
    },
  };
  let configure = (_session: FakeSession) => {};
  const runtime: AgentRuntime = {
    id,
    capabilities,
    validate: (options) => {
      validated.push(options);
    },
    create: (options, host) => {
      const session = new FakeSession(options, host);
      configure(session);
      sessions.push(session);
      return session;
    },
  };
  class FakeSession implements RuntimeSession {
    readonly capabilities = capabilities;
    connected = false;
    terminal: TerminalHandle | undefined;
    commands: RuntimeCommand[] = [];
    closeCalls = 0;
    attachmentCalls = 0;
    failClose = false;
    managed = false;
    startGate?: Promise<void>;
    deliver?: (command: RuntimeCommand) => void | Promise<void>;
    constructor(
      readonly options: RuntimeOptions,
      readonly host: RuntimeHost,
    ) {}
    async start() {
      await this.startGate;
      this.connected = true;
      this.emit({
        type: "session_state",
        state: "idle",
        runtimeSessionId: "native-session",
      });
    }
    send(command: RuntimeCommand) {
      this.commands.push(command);
      if (command.type === "task") this.managed = true;
      return this.deliver?.(command);
    }
    async inspect() {
      return this.connected;
    }
    async attachment() {
      this.attachmentCalls++;
      if (this.managed && !this.capabilities.concurrentNativeInput)
        throw new Error("Native attachment requires no managed task");
      this.terminal ??= { id: this.options.id };
      return this.terminal;
    }
    async close() {
      this.closeCalls++;
      this.connected = false;
      if (this.failClose) throw new Error("Cleanup unavailable");
      this.terminal = undefined;
    }
    emit(event: Parameters<RuntimeHost["emit"]>[0]) {
      this.host.emit(event);
    }
    complete(round = 1, error?: string) {
      this.managed = false;
      this.emit({ type: "session_state", state: "idle", round });
      this.emit({ type: "completed", result: `Result ${round}`, round, error });
    }
  }
  return {
    runtime,
    mux,
    sessions,
    validated,
    opened,
    closedViews,
    configure(callback: typeof configure) {
      configure = callback;
    },
  };
}

test("runtime parsers own configuration and per-round tasks without manager runtime branches", async (t) => {
  const h = harness("custom-parser");
  h.runtime.parseConfig = (raw) => ({
    args: String(raw.runtime_args).split(","),
  });
  h.runtime.parseTask = (command, options) => {
    if (command.type !== "task") return command;
    assert.deepEqual(options.runtimeConfig, { args: ["native"] });
    if (!command.runtimeParams?.target) throw new Error("Target required");
    return {
      ...command,
      prompt: `Normalized native task round ${command.round ?? 1}`,
    };
  };
  const manager = new SubagentManager(h.mux, { runtimes: [h.runtime] });
  t.after(() => manager.close());
  const agent = parseAgentDefinition(
    "---\nruntime: custom-parser\nruntime_config:\n  runtime_args: native\n---\nRole",
    "/agents/native.md",
    "global",
  );
  assert.throws(
    () => manager.spawn({ keepAlive: true, ...task, agent, prompt: "" }),
    /Target required/,
  );
  assert.equal(manager.list().length, 0);
  const started = manager.spawn({
    keepAlive: true,
    ...task,
    agent,
    prompt: "",
    runtimeParams: { target: "first" },
  });
  await until(() => h.sessions[0]?.commands.length === 1);
  assert.deepEqual(h.sessions[0].options.runtimeConfig, { args: ["native"] });
  assert.deepEqual(h.sessions[0].commands[0], {
    type: "task",
    prompt: "Normalized native task round 1",
    runtimeParams: { target: "first" },
  });
  h.sessions[0].complete();
  assert.throws(
    () => manager.resume(started.id, { prompt: "" }),
    /Target required/,
  );
  assert.equal(manager.get(started.id).round, 1);
  manager.resume(started.id, {
    prompt: "",
    runtimeParams: { target: "second" },
  });
  await until(() => h.sessions[0].commands.length === 2);
  assert.deepEqual(h.sessions[0].commands[1], {
    type: "task",
    prompt: "Normalized native task round 2",
    runtimeParams: { target: "second" },
    round: 2,
  });
});

test("runtimes partition opaque call configuration without shared key knowledge", async (t) => {
  const h = harness("future-runtime");
  const calls: { config: Record<string, unknown>; phase: string }[] = [];
  h.runtime.parseCallConfig = (config, sessionConfig, phase) => {
    calls.push({ config, phase });
    const merged = { native: config.native, ...sessionConfig };
    if (
      phase === "resume" &&
      config.native !== undefined &&
      config.native !== sessionConfig.native
    ) {
      throw new Error("Retained session settings are fixed");
    }
    return {
      runtimeConfig: merged,
      runtimeParams: { target: config.target },
    };
  };
  h.runtime.parseTask = (command, options) => {
    if (command.type !== "task") return command;
    assert.equal(options.runtimeConfig?.native, "agent-native");
    if (!command.runtimeParams?.target)
      throw new Error("Fresh target required");
    return command;
  };
  const manager = new SubagentManager(h.mux, { runtimes: [h.runtime] });
  t.after(() => manager.close());
  const started = manager.spawn({
    keepAlive: true,
    ...task,
    runtime: h.runtime.id,
    runtimeConfig: { native: "agent-native" },
    runtimeParams: { native: "call-native", target: "first" },
  });
  await until(() => h.sessions[0]?.commands.length === 1);
  assert.deepEqual(h.sessions[0].options.runtimeConfig, {
    native: "agent-native",
  });
  const first = h.sessions[0].commands[0];
  assert.equal(first.type, "task");
  assert.deepEqual(first.runtimeParams, { target: "first" });
  h.sessions[0].complete();
  assert.throws(
    () => manager.resume(started.id, { prompt: "Next" }),
    /Fresh target required/,
  );
  assert.throws(
    () =>
      manager.resume(started.id, {
        prompt: "Next",
        runtimeParams: { native: "changed", target: "second" },
      }),
    /settings are fixed/,
  );
  assert.equal(manager.get(started.id).round, 1);
  manager.resume(started.id, {
    prompt: "Next",
    runtimeParams: { target: "second" },
  });
  await until(() => h.sessions[0].commands.length === 2);
  const second = h.sessions[0].commands[1];
  assert.equal(second.type, "task");
  assert.deepEqual(second.runtimeParams, { target: "second" });
  assert.equal(h.sessions.length, 1);
  assert.deepEqual(
    calls.map(({ phase }) => phase),
    ["spawn", "resume", "resume", "resume"],
  );
});

test("runtimes without parsers receive opaque configuration without shared field validation", async (t) => {
  const h = harness("legacy");
  const manager = new SubagentManager(h.mux, { runtimes: [h.runtime] });
  t.after(() => manager.close());
  assert.throws(
    () =>
      manager.spawn({
        keepAlive: true,
        ...task,
        runtime: "legacy",
        prompt: "",
      }),
    /must not be blank/,
  );
  assert.equal(manager.list().length, 0);
  const config = { future_session_option: { opaque: true } };
  const params = { future_task_option: ["native"] };
  const started = manager.spawn({
    keepAlive: true,
    ...task,
    runtime: "legacy",
    runtimeConfig: config,
    runtimeParams: params,
  });
  await until(() => h.sessions[0]?.commands.length === 1);
  assert.deepEqual(h.sessions[0].options.runtimeConfig, config);
  const first = h.sessions[0].commands[0];
  assert.equal(first.type, "task");
  assert.deepEqual(first.runtimeParams, params);
  h.sessions[0].complete();
  manager.resume(started.id, {
    prompt: "Next",
    runtimeParams: { future_task_option: "second" },
  });
  await until(() => h.sessions[0].commands.length === 2);
  assert.equal(manager.get(started.id).round, 2);
});

test("shutdown retries failed runtimes without closing successful sessions again", async (t) => {
  const h = harness();
  const manager = new SubagentManager(h.mux, { runtimes: [h.runtime] });
  t.after(async () => {
    for (const session of h.sessions) session.failClose = false;
    await manager.close();
  });
  const first = manager.spawn({ ...task, runtime: "codex" });
  const second = manager.spawn({ ...task, runtime: "codex" });
  await until(() => h.sessions.length === 2);
  await until(() =>
    h.sessions.every((session) => session.commands.length === 1),
  );
  h.sessions[0].failClose = true;
  const closing = manager.close();
  assert.equal(manager.close(), closing);
  await assert.rejects(closing, new RegExp(`${first.id}: runtime`));
  assert.equal(manager.get(second.id).sessionState, "closed");
  assert.equal(manager.get(second.id).status, "stopped");
  assert.throws(() => manager.spawn(task), /closed/);
  const successfulCalls = h.sessions[1].closeCalls;
  h.sessions[0].failClose = false;
  const retry = manager.close();
  assert.notEqual(retry, closing);
  await retry;
  assert.equal(manager.get(first.id).sessionState, "closed");
  assert.equal(h.sessions[1].closeCalls, successfulCalls);
  assert.equal(manager.close(), retry);
});

test("shutdown retains failed view and runtime ownership for retry", async (t) => {
  const h = harness();
  const manager = new SubagentManager(h.mux, { runtimes: [h.runtime] });
  let canCloseView = false;
  let attempts = 0;
  h.mux.close_view = async (view) => {
    attempts++;
    if (!canCloseView) throw new Error("View cleanup unavailable");
    h.closedViews.push(view.id);
  };
  t.after(async () => {
    canCloseView = true;
    for (const session of h.sessions) session.failClose = false;
    await manager.close();
  });
  const agent = manager.spawn({ keepAlive: true, ...task, runtime: "codex" });
  await until(() => h.sessions[0]?.commands.length === 1);
  h.sessions[0].complete();
  const view = await manager.openView(agent.id);
  h.sessions[0].failClose = true;
  await assert.rejects(
    manager.close(),
    new RegExp(`${agent.id}: view and runtime`),
  );
  assert.equal(manager.get(agent.id).viewId, view.id);
  const runtimeCalls = h.sessions[0].closeCalls;
  canCloseView = true;
  h.sessions[0].failClose = false;
  await manager.close();
  assert.equal(manager.get(agent.id).viewId, undefined);
  assert.equal(manager.get(agent.id).sessionState, "closed");
  assert.ok(h.sessions[0].closeCalls > runtimeCalls);
  assert.equal(attempts, 2);
});

test("registered runtime names work without parser or manager enum changes", async (t) => {
  const h = harness("test-runtime");
  const manager = new SubagentManager(h.mux, {
    runtimes: [{ ...h.runtime, displayName: "Test Runtime" }],
  });
  t.after(() => manager.close());
  const agent = parseAgentDefinition(
    "---\nruntime: test-runtime\n---\nRole",
    "/agents/custom.md",
    "project",
  );
  const spawned = manager.spawn({ ...task, agent, model: "call-model" });
  assert.equal(spawned.runtime, "test-runtime");
  assert.equal(spawned.runtimeName, "Test Runtime");
  assert.equal(spawned.model, "call-model");
  assert.equal(spawned.configuredModel, undefined);
  await until(() => h.sessions[0]?.commands.length === 1);
  h.sessions[0].complete();
  assert.equal((await manager.result(spawned.id, true)).status, "completed");
});

test("registered runtimes own prompt validation and accept native Pi snapshots by capability", async (t) => {
  const h = harness("native-pi");
  h.runtime.capabilities.nativeClone = true;
  const manager = new SubagentManager(h.mux, {
    runtimes: [
      {
        ...h.runtime,
        parseConfig: (config) => ({ ...config }),
        validate(options) {
          h.runtime.validate(options);
          if (options.runtimeConfig?.prompt_mode === "replace") {
            throw new Error("This runtime requires append mode");
          }
        },
      },
    ],
  });
  t.after(() => manager.close());
  const agent = parseAgentDefinition(
    "---\nruntime: native-pi\nruntime_config:\n  prompt_mode: append\n  inherit_context: true\n---\nRole",
    "/agents/custom.md",
    "project",
  );
  const parentSession = { entries: [] };
  const spawned = manager.spawn({ ...task, agent, parentSession });
  assert.equal(h.validated[0].runtimeConfig?.prompt_mode, "append");
  assert.equal(h.validated[0].parentSession, parentSession);
  await until(() => h.sessions[0]?.commands.length === 1);
  h.sessions[0].complete();
  assert.equal((await manager.result(spawned.id)).status, "completed");
  assert.throws(
    () =>
      manager.spawn({
        ...task,
        agent: { ...agent, runtimeConfig: { prompt_mode: "replace" } },
        parentSession,
      }),
    /This runtime requires append mode/,
  );
  assert.equal(h.validated.length, 2);
  assert.equal(h.sessions.length, 1);
});

test("runtime preparation freezes opaque context before queueing and is not repeated on resume", async (t) => {
  const h = harness("native-context-runtime");
  h.runtime.capabilities.nativeClone = true;
  h.runtime.parseConfig = (config) => ({ ...config });
  let captures = 0;
  h.runtime.prepareSpawn = (options) => {
    if (!options.runtimeConfig?.native_clone) return options;
    captures += 1;
    const context = options.context as { file: string };
    return {
      ...options,
      context: undefined,
      parentSession: { entries: [], sourcePath: context.file },
    };
  };
  const manager = new SubagentManager(h.mux, {
    runtimes: [h.runtime],
    maxConcurrent: 1,
  });
  t.after(() => manager.close());
  const first = manager.spawn({
    keepAlive: true,
    ...task,
    runtime: h.runtime.id,
  });
  await until(() => h.sessions[0]?.commands.length === 1);
  const context = { file: "/parent/original.jsonl" };
  const queued = manager.spawn({
    keepAlive: true,
    ...task,
    runtime: h.runtime.id,
    runtimeConfig: { native_clone: true },
    context,
  });
  assert.equal(queued.status, "queued");
  assert.equal(queued.inheritedContext, true);
  assert.equal(captures, 1);
  context.file = "/parent/changed.jsonl";
  h.sessions[0].complete();
  await until(() => h.sessions[1]?.commands.length === 1);
  assert.equal(h.sessions[1].options.context, undefined);
  assert.equal(
    h.sessions[1].options.parentSession?.sourcePath,
    "/parent/original.jsonl",
  );
  h.sessions[1].complete();
  manager.resume(queued.id, { prompt: "Next" });
  await until(() => h.sessions[1].commands.length === 2);
  assert.equal(captures, 1);
  assert.equal(h.sessions.length, 2);
  assert.equal(manager.get(first.id).status, "completed");
});

test("clone capability rejects unsupported inheritance even when runtime is named pi", async (t) => {
  const h = harness("pi");
  const manager = new SubagentManager(h.mux, { runtimes: [h.runtime] });
  t.after(() => manager.close());
  assert.throws(
    () => manager.spawn({ ...task, parentSession: { entries: [] } }),
    /context cloning is unsupported/,
  );
  assert.equal(h.sessions.length, 0);
  assert.equal(manager.list().length, 0);
});

test("long Codex roles do not consume task command budget on spawn or resume", async (t) => {
  const h = harness();
  const manager = new SubagentManager(h.mux, { runtimes: [h.runtime] });
  t.after(() => manager.close());
  const agent = parseAgentDefinition(
    `---\nruntime: codex\n---\n${"R".repeat(40_000)}`,
    "/agents/codex.md",
    "project",
  );
  const prompt = "P".repeat(30_000);
  const spawned = manager.spawn({ keepAlive: true, ...task, agent, prompt });
  await until(() => h.sessions[0]?.commands.length === 1);
  assert.equal(h.validated[0].agent?.systemPrompt, agent.systemPrompt);
  assert.deepEqual(h.sessions[0].commands[0], {
    type: "task",
    prompt,
  });
  h.sessions[0].complete();
  manager.resume(spawned.id, { prompt });
  await until(() => h.sessions[0].commands.length === 2);
  assert.deepEqual(h.sessions[0].commands[1], {
    type: "task",
    prompt,
    round: 2,
  });
  h.sessions[0].complete(2);
  assert.equal(h.sessions.length, 1);
  assert.equal((await manager.result(spawned.id)).status, "completed");
});

test("runtime injection waits for ready, forwards options and resumes without any terminal", async (t) => {
  const h = harness();
  const gate = deferred();
  h.configure((session) => {
    session.startGate = gate.promise;
  });
  const manager = new SubagentManager(h.mux, {
    runtimes: [h.runtime],
    executable: "legacy-pi-only",
    runtimeExecutables: { codex: "custom-codex" },
    workerPath: "pi-worker-only.ts",
    extensionAllowlist: ["builtin:mcp"],
    startupTimeoutMs: 1234,
  });
  t.after(() => manager.close());
  const agent = parseAgentDefinition(
    "---\nruntime: codex\nmodel: agent-model\nthinking: high\n---\nRole",
    "/agents/a.md",
    "project",
  );
  const first = manager.spawn({
    keepAlive: true,
    ...task,
    runtime: "pi",
    agent,
    model: "model",
    thinking: "low",
  });
  assert.equal(first.runtime, "codex", "Agent definition takes precedence");
  assert.deepEqual(first.capabilities, h.runtime.capabilities);
  assert.equal(first.status, "starting");
  assert.equal(h.sessions[0].commands.length, 0);
  assert.equal(h.validated[0].executable, "custom-codex");
  assert.equal(h.validated[0].workerPath, undefined);
  assert.equal(h.validated[0].extensionAllowlist, undefined);
  assert.equal(h.validated[0].startupTimeoutMs, 1234);
  assert.equal(h.validated[0].model, "agent-model");
  assert.equal(h.validated[0].thinking, "high");
  gate.resolve();
  await until(() => h.sessions[0].commands.length === 1);
  assert.equal(manager.get(first.id).runtimeSessionId, "native-session");
  assert.equal(manager.get(first.id).terminalId, undefined);
  h.sessions[0].emit({ type: "model_select", model: "resolved-model" });
  assert.equal(manager.get(first.id).model, "resolved-model");
  assert.equal(manager.get(first.id).configuredModel, "agent-model");
  h.sessions[0].complete();
  manager.resume(first.id, { prompt: "Continue" });
  await until(() => h.sessions[0].commands.length === 2);
  assert.equal(h.sessions.length, 1);
  assert.equal(h.sessions[0].commands[1].round, 2);
  h.sessions[0].complete(2);
  assert.equal((await manager.result(first.id)).result, "Result 2");
});

test("concurrent native attachment opens a running headless runtime without changing managed ownership", async (t) => {
  const h = harness();
  h.runtime.capabilities.concurrentNativeInput = true;
  const manager = new SubagentManager(h.mux, { runtimes: [h.runtime] });
  t.after(() => manager.close());
  const agent = manager.spawn({ ...task, runtime: h.runtime.id });
  await until(() => h.sessions[0]?.commands.length === 1);
  assert.equal(manager.get(agent.id).terminalId, undefined);
  const view = await manager.openView(agent.id);
  assert.deepEqual(h.opened, [agent.id]);
  assert.equal(manager.get(agent.id).status, "running");
  assert.equal(manager.get(agent.id).viewId, view.id);
  await manager.closeView(agent.id);
  assert.equal(h.sessions[0].closeCalls, 0);
  assert.equal(h.sessions[0].managed, true);
  h.sessions[0].complete();
  assert.equal(manager.get(agent.id).result, "Result 1");
});

test("lazy native attachment errors leave queued/running tasks intact and view closure never closes execution", async (t) => {
  const h = harness();
  const manager = new SubagentManager(h.mux, {
    runtimes: [h.runtime],
    maxConcurrent: 1,
  });
  t.after(() => manager.close());
  const first = manager.spawn({ keepAlive: true, ...task, runtime: "codex" });
  const queued = manager.spawn({ keepAlive: true, ...task, runtime: "codex" });
  await assert.rejects(manager.openView(queued.id), /not ready/);
  await until(() => h.sessions[0].commands.length === 1);
  await assert.rejects(manager.openView(first.id), /no managed task/);
  assert.equal(manager.get(first.id).status, "running");
  assert.deepEqual(h.opened, []);
  h.sessions[0].complete();
  const view = await manager.openView(first.id);
  assert.equal(manager.get(first.id).terminalId, first.id);
  await manager.closeView(first.id);
  assert.deepEqual(h.closedViews, [view.id]);
  assert.equal(h.sessions[0].closeCalls, 0);
  assert.equal(h.sessions[0].connected, true);
  // Even a retained idle backend must not attach while its resume is queued.
  manager.resume(first.id, { prompt: "Queued continuation" });
  const attachments = h.sessions[0].attachmentCalls;
  await assert.rejects(manager.openView(first.id), /no managed task/);
  assert.equal(h.sessions[0].attachmentCalls, attachments);
  manager.stop(first.id);
  await manager.remove(first.id);
  assert.ok(h.sessions[0].closeCalls > 0);
  assert.throws(() => manager.get(first.id), /Unknown/);
});

test("Codex cross-runtime cloning is rejected synchronously before resources or records exist", async () => {
  const h = harness();
  const manager = new SubagentManager(h.mux);
  assert.throws(
    () =>
      manager.spawn({
        ...task,
        runtime: "codex",
        parentSession: {} as NonNullable<RuntimeOptions["parentSession"]>,
      }),
    /cannot clone/,
  );
  assert.equal(manager.list().length, 0);
  assert.equal(h.sessions.length, 0);
  await manager.close();
});

test("a partially started runtime retains resources and its slot until runtime close succeeds", async (t) => {
  const h = harness("pi");
  const gate = deferred();
  h.configure((session) => {
    if (h.sessions.length) return;
    session.startGate = gate.promise;
    session.terminal = { id: session.options.id };
    session.failClose = true;
  });
  const manager = new SubagentManager(h.mux, {
    runtimes: [h.runtime],
    maxConcurrent: 1,
  });
  t.after(async () => {
    h.sessions[0].failClose = false;
    await manager.close();
  });
  const first = manager.spawn(task);
  const next = manager.spawn(task);
  gate.reject(new Error("Partial startup failed"));
  await until(() => manager.get(first.id).status === "disconnected");
  assert.equal(manager.get(first.id).terminalId, first.id);
  assert.equal(manager.get(next.id).status, "queued");
  h.sessions[0].failClose = false;
  manager.stop(first.id);
  await until(() => h.sessions.length === 2);
  assert.equal(manager.get(first.id).terminalId, undefined);
  assert.equal(manager.get(first.id).status, "stopped");
});

test("late async task/cancel failures cannot terminate a subsequent round", async (t) => {
  const h = harness();
  const taskDelivery = deferred();
  const cancelDelivery = deferred();
  h.configure((session) => {
    session.deliver = (command) => {
      if (command.type === "task" && !command.round)
        return taskDelivery.promise;
      if (command.type === "cancel") return cancelDelivery.promise;
    };
  });
  const manager = new SubagentManager(h.mux, { runtimes: [h.runtime] });
  t.after(() => manager.close());
  const first = manager.spawn({ keepAlive: true, ...task, runtime: "codex" });
  await until(() => h.sessions[0].commands.length === 1);
  const session = h.sessions[0];
  session.complete();
  manager.resume(first.id, { prompt: "Round 2" });
  await until(() => session.commands.length === 2);
  taskDelivery.reject(new Error("Late round 1 delivery failure"));
  session.emit({ type: "started", round: 2 });
  assert.equal(manager.stop(first.id).status, "stopping");
  assert.equal(session.commands[2].round, 2);
  session.complete(2);
  manager.resume(first.id, { prompt: "Round 3" });
  await until(() => session.commands.length === 4);
  cancelDelivery.reject(new Error("Late round 2 cancel failure"));
  await delay(10);
  assert.equal(manager.get(first.id).round, 3);
  assert.equal(manager.get(first.id).status, "running");
  assert.equal(session.closeCalls, 0);
});

test("uncertain async resumed delivery/cancel closes the parent-owned runtime", async (t) => {
  const h = harness();
  const delivery = deferred();
  h.configure((session) => {
    session.deliver = (command) => {
      if (command.type === "task" && command.round === 2)
        return delivery.promise;
      if (command.type === "cancel")
        return Promise.reject(new Error("Cancel delivery unknown"));
    };
  });
  const manager = new SubagentManager(h.mux, {
    runtimes: [h.runtime],
    maxConcurrent: 1,
    cancelTimeoutMs: 5,
  });
  t.after(() => manager.close());
  const first = manager.spawn({ keepAlive: true, ...task, runtime: "codex" });
  await until(() => h.sessions[0].commands.length === 1);
  h.sessions[0].complete();
  manager.resume(first.id, { prompt: "Round 2" });
  await until(() => h.sessions[0].commands.length === 2);
  assert.equal(manager.stop(first.id).status, "stopping");
  delivery.reject(new Error("Transport outcome unknown"));
  await until(() => manager.get(first.id).status === "stopped");
  assert.equal(manager.get(first.id).sessionState, "closed");
  assert.ok(h.sessions[0].closeCalls > 0);
  const queued = manager.spawn({ keepAlive: true, ...task, runtime: "codex" });
  await until(() => manager.get(queued.id).status === "running");
});

test("finished native session cleanup failures retain ownership and stop retries without changing results", async (t) => {
  const h = harness();
  const manager = new SubagentManager(h.mux, { runtimes: [h.runtime] });
  t.after(async () => {
    h.sessions[0].failClose = false;
    await manager.close();
  });
  const agent = manager.spawn({ keepAlive: true, ...task, runtime: "codex" });
  await until(() => h.sessions[0]?.commands.length === 1);
  h.sessions[0].complete();
  const finished = manager.get(agent.id);
  h.sessions[0].emit({ type: "session_state", state: "interactive" });
  const view = await manager.openView(agent.id);
  h.sessions[0].failClose = true;
  h.sessions[0].connected = false;
  h.sessions[0].emit({ type: "disconnected", error: "Control lost" });
  await until(() => h.sessions[0].closeCalls > 0 && !h.sessions[0].connected);
  await until(
    () =>
      manager.get(agent.id).sessionActivity?.includes("cleanup failed") ===
      true,
  );
  assert.equal(manager.get(agent.id).status, finished.status);
  assert.equal(manager.get(agent.id).result, finished.result);
  assert.equal(manager.get(agent.id).sessionState, "disconnected");
  assert.deepEqual(h.closedViews, [view.id]);
  h.sessions[0].failClose = false;
  manager.stop(agent.id);
  await until(() => manager.get(agent.id).sessionState === "closed");
  assert.equal(manager.get(agent.id).status, finished.status);
  assert.equal(manager.get(agent.id).result, finished.result);
});

test("normalized disconnect reports runtime errors; steering can be awaited without unhandled rejection", async (t) => {
  const h = harness();
  h.configure((session) => {
    session.deliver = (command) => {
      if (command.type === "steer")
        return Promise.reject(new Error("Steering rejected"));
    };
  });
  const manager = new SubagentManager(h.mux, { runtimes: [h.runtime] });
  t.after(() => manager.close());
  const first = manager.spawn({ ...task, runtime: "codex" });
  await until(() => h.sessions[0].commands.length === 1);
  await assert.rejects(
    async () => manager.steer(first.id, "Hint"),
    /Steering rejected/,
  );
  assert.equal(manager.get(first.id).status, "running");
  const result = manager.result(first.id, true);
  h.sessions[0].connected = false;
  h.sessions[0].emit({ type: "disconnected", error: "Backend exited" });
  assert.equal((await result).error, "Backend exited");
  assert.equal(manager.get(first.id).sessionState, "closed");
});

test("a definitive runtime rejection preserves an idle native UI and releases only the managed slot", async (t) => {
  const h = harness();
  let rejectSubmission = true;
  h.configure((session) => {
    session.deliver = async (command) => {
      if (command.type === "task" && command.round && rejectSubmission) {
        // A backend preflight rejection is not a TUI-liveness restriction.
        session.managed = false;
        throw new RuntimeTaskRejectedError("Backend rejected submission");
      }
    };
  });
  const manager = new SubagentManager(h.mux, {
    runtimes: [h.runtime],
    maxConcurrent: 1,
  });
  t.after(() => manager.close());
  const first = manager.spawn({ keepAlive: true, ...task, runtime: "codex" });
  await until(() => h.sessions[0].commands.length === 1);
  const session = h.sessions[0];
  session.complete();
  const view = await manager.openView(first.id);
  manager.resume(first.id, { prompt: "Rejected continuation" });
  const rejected = await manager.result(first.id, true);
  assert.equal(rejected.status, "error");
  assert.match(rejected.error ?? "", /Backend rejected/);
  assert.equal(rejected.sessionState, "idle");
  assert.equal(rejected.terminalId, first.id);
  assert.equal(rejected.viewId, view.id);
  assert.equal(session.closeCalls, 0);
  assert.deepEqual(h.closedViews, []);
  const next = manager.spawn({ keepAlive: true, ...task, runtime: "codex" });
  await until(() => h.sessions.length === 2);
  h.sessions[1].complete();
  assert.equal(manager.get(next.id).status, "completed");
  rejectSubmission = false;
  manager.resume(first.id, { prompt: "Continue with idle native TUI alive" });
  await until(() => session.commands.length === 3);
  assert.equal(manager.get(first.id).status, "running");
  assert.equal(session.commands[2].round, 3);
  session.complete(3);
});

test("startup disconnection cleans up even when the startup promise resolves", async (t) => {
  const h = harness();
  h.configure((session) => {
    const start = session.start.bind(session);
    session.start = async () => {
      await start();
      session.connected = false;
      session.emit({ type: "disconnected", error: "Startup connection lost" });
    };
  });
  const manager = new SubagentManager(h.mux, { runtimes: [h.runtime] });
  t.after(() => manager.close());
  const agent = manager.spawn({
    ...task,
    runtime: h.runtime.id,
    keepAlive: true,
  });
  const failed = await manager.result(agent.id, true);
  assert.equal(failed.status, "error");
  assert.equal(failed.sessionState, "closed");
  assert.match(failed.error ?? "", /disconnected during startup/);
  assert.equal(h.sessions[0].closeCalls, 1);
  assert.deepEqual(h.sessions[0].commands, []);
});

test("native work winning startup blocks initial managed dispatch without cancel or cleanup", async (t) => {
  const h = harness();
  h.configure((session) => {
    const start = session.start.bind(session);
    session.start = async () => {
      await start();
      session.emit({ type: "session_state", state: "interactive" });
    };
  });
  const manager = new SubagentManager(h.mux, { runtimes: [h.runtime] });
  t.after(() => manager.close());
  const agent = manager.spawn({
    ...task,
    runtime: h.runtime.id,
  });
  const rejected = await manager.result(agent.id, true);
  assert.equal(rejected.status, "error");
  assert.equal(rejected.sessionState, "interactive");
  assert.deepEqual(h.sessions[0].commands, []);
  assert.equal(rejected.keepAlive, false);
  assert.equal(rejected.viewId, undefined);
  await delay(20); // Allow the queued auto-release operation to run.
  assert.equal(h.sessions[0].closeCalls, 0);
  assert.equal(manager.get(agent.id).sessionState, "interactive");
  h.sessions[0].emit({
    type: "session_update",
    interactionId: "native-startup",
    sequence: 1,
    response: "Native reply",
    outcome: "completed",
  });
  h.sessions[0].emit({ type: "session_state", state: "idle" });
  await until(() => h.sessions[0].closeCalls === 1);
  assert.equal(manager.get(agent.id).result, "Native reply");
  assert.equal(manager.get(agent.id).sessionState, "closed");
});

test("auto-release rechecks native ownership after awaiting detached view inspection", async (t) => {
  const h = harness();
  h.runtime.capabilities.concurrentNativeInput = true;
  const manager = new SubagentManager(h.mux, { runtimes: [h.runtime] });
  t.after(() => manager.close());
  const agent = manager.spawn({ ...task, runtime: h.runtime.id });
  await until(() => h.sessions[0].commands.length === 1);
  await manager.openView(agent.id);
  const inspected = deferred();
  let inspecting = false;
  h.mux.inspect_view = async () => {
    inspecting = true;
    await inspected.promise;
    return { alive: false };
  };
  h.sessions[0].complete();
  await until(() => inspecting);
  h.sessions[0].emit({ type: "session_state", state: "interactive" });
  inspected.resolve();
  await until(() => h.closedViews.length === 1);
  await delay(20);
  assert.equal(h.sessions[0].closeCalls, 0);
  assert.equal(manager.get(agent.id).sessionState, "interactive");
  h.sessions[0].emit({ type: "session_state", state: "idle" });
  await until(() => h.sessions[0].closeCalls === 1);
});

test("initial task rejection retains the ready runtime and restores idle without cleanup", async (t) => {
  const h = harness();
  let rejectTask = true;
  h.configure((session) => {
    session.deliver = async (command) => {
      if (command.type === "task" && rejectTask) {
        session.managed = false;
        throw new RuntimeTaskRejectedError("Native thread is busy");
      }
    };
  });
  const manager = new SubagentManager(h.mux, {
    runtimes: [h.runtime],
    maxConcurrent: 1,
  });
  t.after(() => manager.close());
  const first = manager.spawn({ keepAlive: true, ...task, runtime: "codex" });
  const result = await manager.result(first.id, true);
  assert.equal(result.status, "error");
  assert.equal(result.error, "Native thread is busy");
  assert.equal(result.sessionState, "idle");
  assert.equal(h.sessions[0].closeCalls, 0);
  assert.equal(h.sessions[0].connected, true);
  rejectTask = false;
  manager.resume(first.id, { prompt: "Submit once native work has settled" });
  await until(() => h.sessions[0].commands.length === 2);
  assert.equal(manager.get(first.id).status, "running");
  h.sessions[0].complete(2);
});

test("executable and Pi worker configuration are scoped to the selected runtime", async (t) => {
  for (const override of [undefined, "override-pi"]) {
    const h = harness("pi");
    const manager = new SubagentManager(h.mux, {
      runtimes: [h.runtime],
      executable: "legacy-pi",
      runtimeExecutables: override ? { pi: override } : undefined,
      workerPath: "custom-worker.ts",
      extensionAllowlist: [],
    });
    t.after(() => manager.close());
    manager.spawn(task);
    assert.equal(h.validated[0].executable, override ?? "legacy-pi");
    assert.equal(h.validated[0].workerPath, "custom-worker.ts");
    assert.deepEqual(h.validated[0].extensionAllowlist, []);
    await until(() => h.sessions[0].commands.length === 1);
  }
  const h = harness();
  const manager = new SubagentManager(h.mux, {
    runtimes: [h.runtime],
    executable: "must-not-be-codex",
    workerPath: "pi-only-worker.ts",
    extensionAllowlist: [],
  });
  t.after(() => manager.close());
  manager.spawn({ ...task, runtime: "codex" });
  assert.equal(h.validated[0].executable, undefined);
  assert.equal(h.validated[0].workerPath, undefined);
  assert.equal(h.validated[0].extensionAllowlist, undefined);
  await until(() => h.sessions[0].commands.length === 1);
});

test("default terminal rounds release resources and preserve results and errors", async (t) => {
  for (const outcome of ["completed", "stopped", "error"] as const) {
    const h = harness();
    const manager = new SubagentManager(h.mux, { runtimes: [h.runtime] });
    t.after(() => manager.close());
    const agent = manager.spawn({ ...task, runtime: h.runtime.id });
    assert.equal(agent.keepAlive, false);
    await until(() => h.sessions[0]?.commands.length === 1);
    const session = h.sessions[0];
    session.managed = false;
    session.emit({
      type: "completed",
      result: "Saved",
      canceled: outcome === "stopped",
      error: outcome === "error" ? "Task failed" : undefined,
    });
    await until(() => manager.get(agent.id).sessionState === "closed");
    const result = await manager.result(agent.id);
    assert.equal(result.status, outcome);
    assert.equal(result.result, "Saved");
    assert.equal(result.error, outcome === "error" ? "Task failed" : undefined);
    assert.equal(result.terminalId, undefined);
    assert.equal(manager.list().length, 1);
    assert.equal(session.closeCalls, 1);
    assert.throws(
      () => manager.resume(agent.id, { prompt: "Next" }),
      /released/,
    );
    await assert.rejects(manager.openView(agent.id), /released/);
    await manager.release(agent.id);
    await manager.close();
    assert.equal(session.closeCalls, 1);
  }
});

test("keepAlive retains workers, agent preference wins, and explicit release is idempotent", async (t) => {
  const h = harness();
  const manager = new SubagentManager(h.mux, { runtimes: [h.runtime] });
  t.after(() => manager.close());
  const definition = parseAgentDefinition(
    "---\nkeep_alive: false\n---\nRole",
    "/agents/one.md",
    "global",
  );
  const retained = manager.spawn({
    ...task,
    runtime: h.runtime.id,
    keepAlive: true,
  });
  const defaulted = manager.spawn({
    ...task,
    runtime: h.runtime.id,
    keepAlive: true,
    agent: definition,
  });
  assert.equal(manager.get(defaulted.id).keepAlive, false);
  await until(() =>
    h.sessions.every((session) => session.commands.length === 1),
  );
  await assert.rejects(manager.release(retained.id), /finished/);
  h.sessions[0].complete();
  h.sessions[1].complete();
  await until(() => manager.get(defaulted.id).sessionState === "closed");
  assert.equal(h.sessions[0].closeCalls, 0);
  const view = await manager.openView(retained.id);
  await Promise.all([
    manager.release(retained.id),
    manager.release(retained.id),
  ]);
  assert.deepEqual(h.closedViews, [view.id]);
  assert.equal(h.sessions[0].closeCalls, 1);
  assert.equal(manager.get(retained.id).result, "Result 1");
  assert.equal(manager.get(retained.id).status, "completed");
});

test("a live view retains a finished worker; closing a running view never cancels", async (t) => {
  const h = harness();
  h.runtime.capabilities.concurrentNativeInput = true;
  const manager = new SubagentManager(h.mux, { runtimes: [h.runtime] });
  t.after(() => manager.close());
  const agent = manager.spawn({ ...task, runtime: h.runtime.id });
  await until(() => h.sessions[0]?.commands.length === 1);
  await manager.openView(agent.id);
  await manager.closeView(agent.id);
  assert.equal(manager.get(agent.id).status, "running");
  assert.equal(h.sessions[0].closeCalls, 0);
  assert.equal(h.sessions[0].commands.length, 1);
  await manager.openView(agent.id);
  h.sessions[0].complete();
  // Drain policy operations while preserving a live view.
  await manager.openView(agent.id);
  assert.equal(h.sessions[0].closeCalls, 0);
  await manager.closeView(agent.id);
  await until(() => manager.get(agent.id).sessionState === "closed");
  assert.equal(manager.get(agent.id).result, "Result 1");
});

test("external view closure releases a worker and polling stops after release or disposal", async (t) => {
  const h = harness();
  h.runtime.capabilities.concurrentNativeInput = true;
  let alive = true;
  let inspections = 0;
  h.mux.inspect_view = async () => {
    inspections++;
    return { alive };
  };
  const manager = new SubagentManager(h.mux, { runtimes: [h.runtime] });
  t.after(() => manager.close());
  const agent = manager.spawn({ ...task, runtime: h.runtime.id });
  await until(() => h.sessions[0]?.commands.length === 1);
  await manager.openView(agent.id);
  h.sessions[0].complete();
  await manager.openView(agent.id);
  alive = false;
  await delay(1_100);
  await until(() => manager.get(agent.id).sessionState === "closed");
  assert.equal(manager.get(agent.id).viewId, undefined);
  const afterRelease = inspections;
  await delay(1_100);
  assert.equal(inspections, afterRelease);
  alive = true;
  const next = manager.spawn({ ...task, runtime: h.runtime.id });
  await until(() => h.sessions[1]?.commands.length === 1);
  await manager.openView(next.id);
  h.sessions[1].complete();
  await manager.openView(next.id);
  await manager.close();
  const afterDisposal = inspections;
  await delay(1_100);
  assert.equal(inspections, afterDisposal);
});

test("opening before completion retains the view, but release during opening forbids attachment", async (t) => {
  const h = harness();
  h.runtime.capabilities.concurrentNativeInput = true;
  const manager = new SubagentManager(h.mux, { runtimes: [h.runtime] });
  t.after(() => manager.close());
  const agent = manager.spawn({ ...task, runtime: h.runtime.id });
  await until(() => h.sessions[0]?.commands.length === 1);
  const gate = deferred();
  const original = h.mux.open_view;
  let entered = false;
  h.mux.open_view = async (options) => {
    entered = true;
    await gate.promise;
    return original(options);
  };
  const opening = manager.openView(agent.id);
  await until(() => entered);
  h.sessions[0].complete();
  gate.resolve();
  await opening;
  await manager.openView(agent.id);
  assert.equal(h.sessions[0].closeCalls, 0);
  await manager.closeView(agent.id);
  await until(() => manager.get(agent.id).sessionState === "closed");

  const next = manager.spawn({
    ...task,
    runtime: h.runtime.id,
    keepAlive: true,
  });
  await until(() => h.sessions[1]?.commands.length === 1);
  h.sessions[1].complete();
  const attachment = deferred();
  const session = h.sessions[1];
  const attach = session.attachment.bind(session);
  session.attachment = async () => {
    await attachment.promise;
    return attach();
  };
  const pending = manager.openView(next.id);
  const rejected = assert.rejects(pending, /released/);
  await delay(5);
  const releasing = manager.release(next.id);
  assert.throws(() => manager.resume(next.id, { prompt: "Race" }), /released/);
  attachment.resolve();
  await rejected;
  await releasing;
  assert.equal(h.opened.includes(next.id), false);
});

test("auto-release failure is visible and stop retries without changing round data", async (t) => {
  const h = harness();
  const manager = new SubagentManager(h.mux, { runtimes: [h.runtime] });
  t.after(async () => {
    h.sessions[0].failClose = false;
    await manager.close();
  });
  const agent = manager.spawn({ ...task, runtime: h.runtime.id });
  await until(() => h.sessions[0]?.commands.length === 1);
  h.sessions[0].failClose = true;
  h.sessions[0].complete(1, "Original error");
  await until(() => manager.get(agent.id).sessionState === "disconnected");
  assert.match(manager.get(agent.id).sessionActivity ?? "", /cleanup failed/);
  assert.equal(manager.get(agent.id).error, "Original error");
  const finished = manager.get(agent.id);
  await assert.rejects(manager.release(agent.id), /retry release/);
  h.sessions[0].failClose = false;
  manager.stop(agent.id);
  await until(() => manager.get(agent.id).sessionState === "closed");
  assert.equal(manager.get(agent.id).result, finished.result);
  assert.equal(manager.get(agent.id).status, finished.status);
  assert.equal(manager.get(agent.id).error, finished.error);
  assert.equal(manager.get(agent.id).completedAt, finished.completedAt);
});

test("failed release retains view ownership even after runtime closes and disposal retries it", async (t) => {
  const h = harness();
  const manager = new SubagentManager(h.mux, { runtimes: [h.runtime] });
  t.after(() => manager.close());
  const agent = manager.spawn({
    ...task,
    runtime: h.runtime.id,
    keepAlive: true,
  });
  await until(() => h.sessions[0]?.commands.length === 1);
  h.sessions[0].complete();
  const view = await manager.openView(agent.id);
  const close = h.mux.close_view;
  h.mux.close_view = async () => {
    throw new Error("Mux unavailable");
  };
  await assert.rejects(manager.release(agent.id), /retry release/);
  assert.equal(manager.get(agent.id).viewId, view.id);
  assert.equal(manager.get(agent.id).terminalId, undefined);
  assert.equal(manager.get(agent.id).result, "Result 1");
  await assert.rejects(manager.close(), /could not be cleaned up/);
  h.mux.close_view = close;
  await manager.close();
  assert.deepEqual(h.closedViews, [view.id]);
  assert.equal(h.sessions[0].closeCalls, 1);
});

test("a resumed round invalidates an in-flight finished-view lifecycle check", async (t) => {
  const h = harness();
  h.runtime.capabilities.concurrentNativeInput = true;
  const manager = new SubagentManager(h.mux, { runtimes: [h.runtime] });
  t.after(() => manager.close());
  const agent = manager.spawn({ ...task, runtime: h.runtime.id });
  await until(() => h.sessions[0]?.commands.length === 1);
  await manager.openView(agent.id);
  const gate = deferred();
  let entered = false;
  h.mux.inspect_view = async () => {
    entered = true;
    await gate.promise;
    return { alive: false };
  };
  h.sessions[0].complete();
  await until(() => entered);
  manager.resume(agent.id, { prompt: "Continue" });
  gate.resolve();
  await until(() => h.sessions[0].commands.length === 2);
  await manager.closeView(agent.id);
  assert.equal(manager.get(agent.id).status, "running");
  assert.equal(h.sessions[0].closeCalls, 0);
  h.sessions[0].complete(2);
  await until(() => manager.get(agent.id).sessionState === "closed");
  assert.equal(manager.get(agent.id).result, "Result 2");
});

test("steer requires the current connected managed running session, independently of views", async (t) => {
  const h = harness();
  h.runtime.capabilities.concurrentNativeInput = true;
  const manager = new SubagentManager(h.mux, { runtimes: [h.runtime] });
  t.after(() => manager.close());
  const agent = manager.spawn({
    ...task,
    runtime: h.runtime.id,
    keepAlive: true,
  });
  await until(() => h.sessions[0]?.commands.length === 1);
  const session = h.sessions[0];
  await manager.openView(agent.id);
  manager.steer(agent.id, "managed guidance");
  assert.equal(session.commands.at(-1)?.type, "steer");
  for (const state of ["interactive", "idle"] as const) {
    session.emit({ type: "session_state", state });
    assert.throws(
      () => manager.steer(agent.id, "forbidden"),
      /connected running managed/,
    );
  }
  session.emit({ type: "session_state", state: "running" });
  session.connected = false;
  assert.throws(
    () => manager.steer(agent.id, "disconnected"),
    /connected running managed/,
  );
  session.connected = true;
  session.capabilities.steer = false;
  assert.throws(
    () => manager.steer(agent.id, "unsupported"),
    /does not support/,
  );
  session.capabilities.steer = true;
  session.complete();
  assert.throws(
    () => manager.steer(agent.id, "finished"),
    /connected running managed/,
  );
});

test("resume rechecks connection and native state after asynchronous inspect", async (t) => {
  for (const race of ["interactive", "disconnect"] as const) {
    await t.test(race, async (t) => {
      const h = harness();
      const manager = new SubagentManager(h.mux, { runtimes: [h.runtime] });
      t.after(() => manager.close());
      const agent = manager.spawn({
        ...task,
        runtime: h.runtime.id,
        keepAlive: true,
      });
      await until(() => h.sessions[0]?.commands.length === 1);
      const session = h.sessions[0];
      session.complete();
      const gate = deferred();
      session.inspect = async () => {
        await gate.promise;
        return true;
      };
      manager.resume(agent.id, { prompt: "queued race" });
      if (race === "interactive")
        session.emit({ type: "session_state", state: "interactive" });
      else session.connected = false;
      gate.resolve();
      const result = await manager.result(agent.id, true);
      assert.equal(result.status, "error");
      assert.equal(session.commands.length, 1);
      assert.equal(session.closeCalls, 0);
      if (race === "interactive")
        assert.equal(result.sessionState, "interactive");
    });
  }
});

test("terminal presence never bypasses managed native-input capability", async (t) => {
  const h = harness();
  const manager = new SubagentManager(h.mux, { runtimes: [h.runtime] });
  t.after(() => manager.close());
  const agent = manager.spawn({
    ...task,
    runtime: h.runtime.id,
    keepAlive: true,
  });
  await until(() => h.sessions[0]?.commands.length === 1);
  const session = h.sessions[0];
  session.terminal = { id: "already-existing" };
  await assert.rejects(manager.openView(agent.id), /requires no managed task/);
  assert.equal(session.attachmentCalls, 0);
  session.complete();
  await manager.openView(agent.id);
  assert.equal(session.attachmentCalls, 1);
});

test("finished stopped and errored idle sessions resume but non-idle or disconnected sessions do not", async (t) => {
  for (const outcome of ["completed", "stopped", "error"] as const) {
    await t.test(outcome, async (t) => {
      const h = harness();
      const manager = new SubagentManager(h.mux, { runtimes: [h.runtime] });
      t.after(() => manager.close());
      const agent = manager.spawn({
        ...task,
        runtime: h.runtime.id,
        keepAlive: true,
      });
      await until(() => h.sessions[0]?.commands.length === 1);
      const session = h.sessions[0];
      if (outcome === "stopped") manager.stop(agent.id);
      session.complete(1, outcome === "error" ? "Task failed" : undefined);
      assert.equal(manager.get(agent.id).status, outcome);
      for (const state of ["running", "interactive"] as const) {
        session.emit({ type: "session_state", state });
        assert.throws(
          () => manager.resume(agent.id, { prompt: "Blocked" }),
          /idle session/,
        );
        assert.equal(manager.get(agent.id).round, 1);
      }
      session.emit({ type: "session_state", state: "idle" });
      session.connected = false;
      assert.throws(
        () => manager.resume(agent.id, { prompt: "Blocked" }),
        /retained, connected/,
      );
      session.connected = true;
      manager.resume(agent.id, { prompt: "Continue" });
      await until(
        () =>
          session.commands.filter((command) => command.type === "task")
            .length === 2,
      );
      assert.equal(manager.get(agent.id).round, 2);
      assert.equal(session.closeCalls, 0);
    });
  }
});

test("auto-release rechecks release ownership after awaited view inspection", async (t) => {
  const h = harness();
  h.runtime.capabilities.concurrentNativeInput = true;
  const manager = new SubagentManager(h.mux, { runtimes: [h.runtime] });
  t.after(() => manager.close());
  const agent = manager.spawn({ ...task, runtime: h.runtime.id });
  await until(() => h.sessions[0]?.commands.length === 1);
  await manager.openView(agent.id);
  const gate = deferred();
  let inspecting = false;
  h.mux.inspect_view = async () => {
    inspecting = true;
    await gate.promise;
    return { alive: false };
  };
  h.sessions[0].complete();
  await until(() => inspecting);
  const releasing = manager.release(agent.id);
  gate.resolve();
  await releasing;
  await delay(20);
  assert.equal(h.sessions[0].closeCalls, 1);
  assert.equal(manager.get(agent.id).sessionState, "closed");
});

test("idle resume dispatches during attachment but recheck rejects nonconcurrent native view", async (t) => {
  const h = harness();
  const manager = new SubagentManager(h.mux, { runtimes: [h.runtime] });
  t.after(() => manager.close());
  const agent = manager.spawn({
    ...task,
    runtime: h.runtime.id,
    keepAlive: true,
  });
  await until(() => h.sessions[0]?.commands.length === 1);
  h.sessions[0].complete();
  const gate = deferred();
  let attaching = false;
  h.sessions[0].attachment = async () => {
    attaching = true;
    await gate.promise;
    return { id: agent.id };
  };
  const opening = manager.openView(agent.id);
  await until(() => attaching);
  manager.resume(agent.id, { prompt: "Idle continuation" });
  await until(() => h.sessions[0].commands.length === 2);
  const rejected = assert.rejects(opening, /requires no managed task/);
  gate.resolve();
  await rejected;
  assert.deepEqual(h.opened, []);
  assert.equal(manager.get(agent.id).status, "running");
});

test("open view rechecks current execution across inspect, focus, and open races", async (t) => {
  for (const phase of [
    "inspect",
    "relative",
    "focus",
    "open",
    "rollback-failure",
  ] as const) {
    await t.test(phase, async (t) => {
      const h = harness();
      const manager = new SubagentManager(h.mux, { runtimes: [h.runtime] });
      t.after(() => manager.close());
      const agent = manager.spawn({
        ...task,
        runtime: h.runtime.id,
        keepAlive: true,
      });
      await until(() => h.sessions[0]?.commands.length === 1);
      h.sessions[0].complete();
      let otherView: string | undefined;
      if (phase === "relative") {
        const other = manager.spawn({
          ...task,
          runtime: h.runtime.id,
          keepAlive: true,
        });
        await until(() => h.sessions[1]?.commands.length === 1);
        h.sessions[1].complete();
        otherView = (await manager.openView(other.id)).id;
      }
      const hasExisting = phase === "inspect" || phase === "focus";
      const existing = hasExisting
        ? await manager.openView(agent.id)
        : undefined;
      const gate = deferred();
      let entered = false;
      let focuses = 0;
      let failClose = phase === "rollback-failure";
      const originalClose = h.mux.close_view;
      h.mux.close_view = async (view) => {
        if (failClose) throw new Error("Close unavailable");
        await originalClose(view);
      };
      const originalInspect = h.mux.inspect_view;
      h.mux.inspect_view = async (view) => {
        if (phase === "inspect" || phase === "relative") {
          entered = true;
          await gate.promise;
        }
        return originalInspect(view);
      };
      h.mux.focus_view = async () => {
        focuses++;
        if (phase === "focus") {
          entered = true;
          await gate.promise;
        }
      };
      const originalOpen = h.mux.open_view;
      h.mux.open_view = async (options) => {
        if (phase === "open" || phase === "rollback-failure") {
          entered = true;
          await gate.promise;
        }
        return originalOpen(options);
      };
      const opening = manager.openView(agent.id);
      const rejected = assert.rejects(opening, /requires no managed task/);
      await until(() => entered);
      manager.resume(agent.id, { prompt: "Race continuation" });
      await until(() => h.sessions[0].commands.length === 2);
      gate.resolve();
      await rejected;
      assert.equal(manager.get(agent.id).status, "running");
      if (hasExisting) {
        assert.equal(manager.get(agent.id).viewId, existing?.id);
        assert.deepEqual(h.closedViews, []);
        assert.equal(focuses, phase === "focus" ? 1 : 0);
      } else if (phase === "relative") {
        assert.equal(h.opened.length, 1);
        assert.deepEqual(h.closedViews, []);
        assert.equal(
          manager.list().some((record) => record.viewId === otherView),
          true,
        );
      } else if (failClose) {
        assert.equal(manager.get(agent.id).viewId, `view-${agent.id}`);
        failClose = false;
        await manager.closeView(agent.id);
        assert.deepEqual(h.closedViews, [`view-${agent.id}`]);
        assert.equal(manager.get(agent.id).viewId, undefined);
      } else {
        assert.deepEqual(h.closedViews, [`view-${agent.id}`]);
        assert.equal(manager.get(agent.id).viewId, undefined);
      }
    });
  }
});
