import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { parseAgentDefinition } from "./agents.ts";
import { SubagentManager } from "./manager.ts";
import type { MuxAdapter, TerminalHandle } from "./mux.ts";
import type {
  AgentRuntime,
  RuntimeCommand,
  RuntimeHost,
  RuntimeId,
  RuntimeOptions,
  RuntimeSession,
} from "./runtime.ts";
import { RuntimeTaskRejectedError } from "./runtime-errors.ts";

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
      if (this.managed)
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

test("lazy native attachment errors leave queued/running tasks intact and view closure never closes execution", async (t) => {
  const h = harness();
  const manager = new SubagentManager(h.mux, {
    runtimes: [h.runtime],
    maxConcurrent: 1,
  });
  t.after(() => manager.close());
  const first = manager.spawn({ ...task, runtime: "codex" });
  const queued = manager.spawn({ ...task, runtime: "codex" });
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
  const first = manager.spawn({ ...task, runtime: "codex" });
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

test("uncertain async resumed delivery/cancel retains native ownership and concurrency", async (t) => {
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
  const first = manager.spawn({ ...task, runtime: "codex" });
  await until(() => h.sessions[0].commands.length === 1);
  h.sessions[0].complete();
  manager.resume(first.id, { prompt: "Round 2" });
  await until(() => h.sessions[0].commands.length === 2);
  assert.equal(manager.stop(first.id).status, "stopping");
  delivery.reject(new Error("Transport outcome unknown"));
  await until(() => manager.get(first.id).status === "disconnected");
  assert.match(manager.get(first.id).error ?? "", /slot retained/);
  assert.equal(h.sessions[0].closeCalls, 0);
  const queued = manager.spawn({ ...task, runtime: "codex" });
  assert.equal(queued.status, "queued");
  assert.equal(manager.stop(first.id).status, "disconnected");
  h.sessions[0].complete(2);
  await until(() => h.sessions.length === 2);
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
  let nativeLocked = true;
  h.configure((session) => {
    session.deliver = async (command) => {
      if (command.type === "task" && command.round && nativeLocked) {
        // This typed rejection guarantees the task was never dispatched.
        session.managed = false;
        throw new RuntimeTaskRejectedError("Exit the native TUI before resume");
      }
    };
  });
  const manager = new SubagentManager(h.mux, {
    runtimes: [h.runtime],
    maxConcurrent: 1,
  });
  t.after(() => manager.close());
  const first = manager.spawn({ ...task, runtime: "codex" });
  await until(() => h.sessions[0].commands.length === 1);
  const session = h.sessions[0];
  session.complete();
  const view = await manager.openView(first.id);
  manager.resume(first.id, { prompt: "Rejected continuation" });
  const rejected = await manager.result(first.id, true);
  assert.equal(rejected.status, "error");
  assert.match(rejected.error ?? "", /Exit the native TUI/);
  assert.equal(rejected.sessionState, "idle");
  assert.equal(rejected.terminalId, first.id);
  assert.equal(rejected.viewId, view.id);
  assert.equal(session.closeCalls, 0);
  assert.deepEqual(h.closedViews, []);
  const next = manager.spawn({ ...task, runtime: "codex" });
  await until(() => h.sessions.length === 2);
  h.sessions[1].complete();
  assert.equal(manager.get(next.id).status, "completed");
  nativeLocked = false;
  session.terminal = undefined; // The user exited the TUI, not the manager.
  manager.resume(first.id, { prompt: "Continue after native exit" });
  await until(() => session.commands.length === 3);
  assert.equal(manager.get(first.id).status, "running");
  assert.equal(session.commands[2].round, 3);
  session.complete(3);
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
  const first = manager.spawn({ ...task, runtime: "codex" });
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
