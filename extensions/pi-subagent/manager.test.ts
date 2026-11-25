import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { useAgentDir } from "../../tests/helpers/agent-dir.ts";
import { parseAgentDefinition } from "./config.ts";
import {
  type AgentExecutionState,
  defineExecutor,
  ExecutorError,
  type InspectResult,
  type ReadResult,
  type StartOptions,
} from "./execute/index.ts";
import { createSubagentManager } from "./manager.ts";

export interface TurnDriver {
  alive: boolean;
  state?: AgentExecutionState;
  message?: string;
  resultText: string;
  errorText?: string;
  aborted: boolean;
  wake?: () => void;
}

export function createTestExecutor(supportsView = true) {
  const started: StartOptions[] = [];
  const commands = new Map<
    string,
    Array<{ type: "task" | "steer" | "cancel"; prompt?: string }>
  >();
  const drivers = new Map<string, TurnDriver>();
  const destroyed: string[] = [];

  const getDriver = (id: string): TurnDriver => {
    const existing = drivers.get(id);
    if (existing) return existing;
    const created: TurnDriver = {
      alive: true,
      state: "idle",
      resultText: "",
      aborted: false,
    };
    drivers.set(id, created);
    return created;
  };

  const statusOf = (d: TurnDriver): InspectResult => ({
    alive: d.alive,
    ...(d.alive ? { state: d.state } : {}),
    ...(d.message ? { message: d.message } : {}),
  });

  const executor = defineExecutor({
    id: "herdr-core",
    supportsView,
    check_env: () => true,
    async start(options: StartOptions) {
      started.push(options);
      const d = getDriver(options.agentId);
      d.alive = true;
      d.state = "idle";
      if (!commands.has(options.agentId)) commands.set(options.agentId, []);
      return { id: options.agentId, sessionPath: options.sessionPath };
    },
    inspect: async (terminal) => statusOf(getDriver(terminal.id)),
    async send(terminal, text, sendOpts) {
      const d = getDriver(terminal.id);
      if (!d.alive) {
        throw new ExecutorError("finished", `${terminal.id} is not live`);
      }
      if (d.state === "blocked") {
        throw new ExecutorError("blocked", `${terminal.id} is blocked`);
      }
      if (sendOpts?.if && d.state !== sendOpts.if) {
        throw new ExecutorError(
          "status_mismatch",
          `${terminal.id} is ${d.state ?? "unknown"}, not ${sendOpts.if}`,
        );
      }
      d.state = "working";
      commands.get(terminal.id)?.push({
        type: sendOpts?.if === "working" ? "steer" : "task",
        prompt: text,
      });
    },
    async wait(terminal) {
      const d = getDriver(terminal.id);
      if (d.alive && d.state === "working") {
        await new Promise<void>((resolve) => {
          d.wake = resolve;
        });
      }
      return statusOf(d);
    },
    async interrupt(terminal) {
      commands.get(terminal.id)?.push({ type: "cancel" });
    },
    async read(terminal): Promise<ReadResult> {
      const d = getDriver(terminal.id);
      return {
        text: d.resultText,
        ...(d.errorText ? { error: d.errorText } : {}),
        ...(d.aborted ? { aborted: true } : {}),
        sessionPath: terminal.sessionPath,
      };
    },
    async destroy(terminal) {
      destroyed.push(terminal.id);
      const d = getDriver(terminal.id);
      d.alive = false;
      d.wake?.();
    },
    ...(supportsView
      ? {
          open_view: async ({ terminal }) => ({ id: `view-${terminal.id}` }),
          inspect_view: async () => ({ alive: true }),
          focus_view: async () => undefined,
          close_view: async () => undefined,
        }
      : {}),
  });

  return {
    executor,
    started,
    commands,
    destroyed,
    complete(
      id: string,
      resultText = "Done",
      opts?: { error?: string; aborted?: boolean },
    ) {
      const d = getDriver(id);
      d.resultText = resultText;
      d.errorText = opts?.error;
      d.aborted = opts?.aborted ?? false;
      d.state = opts?.error ? "error" : opts?.aborted ? "idle" : "done";
      d.wake?.();
    },
    disconnect(id: string) {
      const d = getDriver(id);
      d.alive = false;
      d.wake?.();
    },
    setBlocked(id: string, message: string) {
      const d = getDriver(id);
      d.state = "blocked";
      d.message = message;
    },
    setState(id: string, state: AgentExecutionState | undefined) {
      const d = getDriver(id);
      d.state = state;
    },
    checkIn(id: string) {
      const d = getDriver(id);
      d.wake?.();
    },
  };
}

export async function until(check: () => boolean) {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await delay(5);
  }
  assert.fail("Condition did not become true");
}

const task = {
  prompt: "Inspect authentication",
  description: "Inspect auth",
  cwd: "/tmp/project",
};

test("spawn assigns short IDs, dynamic hints, and executes task commands via execute layer", async (t) => {
  useAgentDir(t);
  const exec = createTestExecutor();
  const notifications: string[] = [];
  const manager = createSubagentManager(exec.executor, {
    extensionAllowlist: [],
    onComplete: (record) => notifications.push(record.id),
  });
  t.after(() => manager.close());

  const first = manager.spawn({ ...task, model: "sonnet", thinking: "high" });
  assert.equal(first.id, "sub-1");
  assert.match(first.hint ?? "", /subagent_ctl.*sub-1/);
  await until(() => exec.commands.get(first.id)?.length === 1);

  const start = exec.started[0];
  assert.equal(start.env.PI_KITS_SUBAGENT_WORKER, "1");
  assert.ok(start.argv.includes("--no-extensions"));
  assert.equal(
    start.argv.some((arg) => arg.endsWith("worker.ts")),
    false,
  );
  assert.ok(start.argv.includes("sonnet"));
  assert.ok(start.sessionPath?.endsWith(".jsonl"));
  assert.equal(manager.get(first.id).sessionPath, start.sessionPath);

  // Unified send while running routes to steer
  const steered = await manager.send(first.id, {
    prompt: "Only inspect files",
  });
  assert.match(steered.hint ?? "", /Steering message delivered/);
  assert.deepEqual(exec.commands.get(first.id)?.[1], {
    type: "steer",
    prompt: "Only inspect files",
  });

  const waited = manager.result(first.id, true);
  exec.complete(first.id, "Found auth.ts");
  const completed = await waited;
  assert.equal(completed.result, "Found auth.ts");
  assert.equal(completed.status, "completed");
  assert.match(
    completed.hint ?? "",
    /Task completed.*subagent\(\{ id: "sub-1"/,
  );
  assert.deepEqual(notifications, []);
});

test("cold resume automatically restarts from saved sessionPath after process release", async (t) => {
  useAgentDir(t);
  const exec = createTestExecutor(false);
  const manager = createSubagentManager(exec.executor, {
    extensionAllowlist: [],
  });
  t.after(() => manager.close());

  const agent = manager.spawn(task);
  await until(() => exec.commands.get(agent.id)?.length === 1);
  const firstSessionPath = exec.started[0].sessionPath;
  assert.ok(firstSessionPath);
  assert.ok(exec.started[0].argv.includes("--session"));

  exec.complete(agent.id, "Round 1 done");
  await until(() => manager.get(agent.id).status === "completed");
  await until(() => exec.destroyed.length === 1);
  assert.equal(manager.get(agent.id).sessionState, "closed");

  const resumed = await manager.send(agent.id, {
    prompt: "Continue round 2",
    description: "Round 2",
  });
  assert.equal(resumed.round, 2);
  assert.equal(resumed.description, "Round 2");
  await until(() => exec.started.length === 2);
  const secondArgv = exec.started[1].argv;
  const sessionFlagIdx = secondArgv.indexOf("--session");
  assert.ok(sessionFlagIdx >= 0);
  assert.equal(secondArgv[sessionFlagIdx + 1], firstSessionPath);

  await until(() => exec.commands.get(agent.id)?.length === 2);
  assert.deepEqual(exec.commands.get(agent.id)?.[1], {
    type: "task",
    prompt: "Continue round 2",
  });
});

test("hot resume reuses live terminal session without restarting process", async (t) => {
  useAgentDir(t);
  const exec = createTestExecutor();
  const manager = createSubagentManager(exec.executor, {
    extensionAllowlist: [],
  });
  t.after(() => manager.close());

  const agent = manager.spawn(task);
  await until(() => exec.commands.get(agent.id)?.length === 1);
  await manager.openView(agent.id);
  exec.complete(agent.id, "Round 1");
  await until(() => manager.get(agent.id).status === "completed");
  assert.equal(exec.destroyed.length, 0);

  await manager.send(agent.id, { prompt: "Hot round 2" });
  await until(() => exec.commands.get(agent.id)?.length === 2);
  assert.equal(exec.started.length, 1);
  assert.deepEqual(exec.commands.get(agent.id)?.[1], {
    type: "task",
    prompt: "Hot round 2",
  });
});

test("agent definition configures tools, prompt files, extensions, and context inheritance", async (t) => {
  useAgentDir(t);
  const parent = SessionManager.inMemory(task.cwd);
  parent.appendMessage({
    role: "user",
    content: "Parent context",
    timestamp: 1,
  });

  const exec = createTestExecutor();
  const manager = createSubagentManager(exec.executor, {
    extensionAllowlist: [],
  });
  t.after(() => manager.close());

  const definition = parseAgentDefinition(
    `---
model: agent-model
thinking: high
tools: read, grep
disallowed_tools: write
inherit_context: true
display_name: Reviewer
---
System instructions`,
    "/project/.pi/agent/agents/review.md",
    "project",
  );

  const agent = manager.spawn({
    ...task,
    agent: definition,
    context: parent,
  });
  await until(() => exec.commands.get(agent.id)?.length === 1);
  const argv = exec.started[0].argv;
  assert.equal(argv[argv.indexOf("--model") + 1], "agent-model");
  assert.equal(argv[argv.indexOf("--thinking") + 1], "high");
  assert.equal(argv[argv.indexOf("--tools") + 1], "read,grep");
  assert.equal(argv[argv.indexOf("--exclude-tools") + 1], "write");
  assert.ok(argv.includes("--session"));
  const promptPath = argv[argv.indexOf("--system-prompt") + 1];
  assert.equal(readFileSync(promptPath, "utf8"), "System instructions");
  assert.equal(agent.inheritedContext, true);

  await manager.close();
  assert.equal(existsSync(promptPath), false);
});

test("ECS data-driven entities derive status and sessionState purely from component presence", async (t) => {
  useAgentDir(t);
  const exec = createTestExecutor();
  const manager = createSubagentManager(exec.executor, {
    maxConcurrent: 1,
    extensionAllowlist: [],
  });
  t.after(() => manager.close());

  const first = manager.spawn(task);
  const second = manager.spawn({ ...task, description: "Queued sibling" });
  assert.equal(manager.get(second.id).status, "queued");
  assert.equal(manager.get(second.id).sessionState, undefined);

  await until(() => exec.commands.get(first.id)?.length === 1);
  assert.equal(manager.get(first.id).status, "running");
  assert.equal(manager.get(first.id).sessionState, "running");

  await manager.openView(first.id);
  exec.complete(first.id, "Done 1");
  await until(() => manager.get(first.id).status === "completed");
  assert.equal(manager.get(first.id).sessionState, "idle");

  exec.setBlocked(first.id, "Permission needed");
  const snap = await manager.result(first.id, false);
  assert.equal(snap.sessionState, "interactive");
  assert.equal(snap.status, "completed");
  assert.equal(snap.sessionActivity, "Permission needed");
  assert.match(snap.hint ?? "", /interacting in the native terminal/);
});

test("canceling one result waiter does not release another waiter's notification claim", async (t) => {
  useAgentDir(t);
  const h = createTestExecutor();
  let notifications = 0;
  const manager = createSubagentManager(h.executor, {
    extensionAllowlist: [],
    onComplete: () => {
      notifications += 1;
    },
  });
  t.after(() => manager.close());
  const { id } = manager.spawn(task);
  await until(() => h.commands.get(id)?.length === 1);
  const controller = new AbortController();
  const canceled = manager.result(id, true, controller.signal);
  const remaining = manager.result(id, true);
  controller.abort(new Error("Canceled wait"));
  await assert.rejects(canceled, /Canceled wait/);
  h.complete(id);
  assert.equal((await remaining).status, "completed");
  assert.equal(notifications, 0);
});

test("running cancellation retains its queue slot until the worker settles", async (t) => {
  useAgentDir(t);
  const h = createTestExecutor();
  const manager = createSubagentManager(h.executor, {
    maxConcurrent: 1,
    extensionAllowlist: [],
  });
  t.after(() => manager.close());
  const first = manager.spawn(task);
  const next = manager.spawn(task);
  await until(() => h.commands.get(first.id)?.length === 1);
  assert.equal(manager.stop(first.id).status, "stopping");
  await delay(10);
  assert.equal(h.started.length, 1);
  h.complete(first.id, "Stopped", { aborted: true });
  await until(() => h.commands.get(next.id)?.length === 1);
  assert.equal(manager.get(first.id).status, "stopped");
});

test("unexpected worker exit retains the slot until cleanup succeeds; stop retries failures", async (t) => {
  useAgentDir(t);
  const h = createTestExecutor();
  const destroy = h.executor.destroy.bind(h.executor);
  let canDestroy = false;
  h.executor.destroy = async (terminal) => {
    if (!canDestroy) throw new Error("Server unavailable");
    await destroy(terminal);
  };
  const manager = createSubagentManager(h.executor, {
    maxConcurrent: 1,
    extensionAllowlist: [],
  });
  t.after(async () => {
    canDestroy = true;
    await manager.close();
  });
  const first = manager.spawn(task);
  const next = manager.spawn(task);
  await until(() => h.commands.get(first.id)?.length === 1);
  h.disconnect(first.id);
  await until(() => manager.get(first.id).status === "disconnected");
  assert.equal(h.started.length, 1);
  canDestroy = true;
  manager.stop(first.id);
  await until(() => h.commands.get(next.id)?.length === 1);
  assert.equal(manager.get(first.id).status, "stopped");
  assert.deepEqual(h.destroyed, [first.id]);
});

test("hot resume works from error state and cold start works before OSC status is reported", async (t) => {
  useAgentDir(t);
  const exec = createTestExecutor();
  const baseStart = exec.executor.start.bind(exec.executor);
  exec.executor.start = async (opts) => {
    const handle = await baseStart(opts);
    // Simulate a freshly spawned terminal that has not emitted OSC 7501 yet
    exec.setState(opts.agentId, undefined);
    return handle;
  };
  const manager = createSubagentManager(exec.executor, {
    extensionAllowlist: [],
  });
  t.after(() => manager.close());

  const agent = manager.spawn(task);
  await until(() => exec.commands.get(agent.id)?.length === 1);
  await manager.openView(agent.id);

  exec.complete(agent.id, "", { error: "Tool failed" });
  await until(() => manager.get(agent.id).status === "error");
  assert.equal(exec.destroyed.length, 0);

  // Hot resume from error state reuses the live terminal without status_mismatch
  await manager.send(agent.id, { prompt: "Retry after error" });
  await until(() => exec.commands.get(agent.id)?.length === 2);
  assert.equal(exec.started.length, 1);

  exec.complete(agent.id, "Recovered");
  await until(() => manager.get(agent.id).status === "completed");
  assert.equal(manager.get(agent.id).result, "Recovered");
});

test("steer enforces working state and rejects with status_mismatch if terminal already finished", async (t) => {
  useAgentDir(t);
  const exec = createTestExecutor();
  const manager = createSubagentManager(exec.executor, {
    extensionAllowlist: [],
  });
  t.after(() => manager.close());

  const agent = manager.spawn(task);
  await until(() => exec.commands.get(agent.id)?.length === 1);

  // Terminal flipped to done before wait() settled the turn in manager
  exec.setState(agent.id, "done");
  await assert.rejects(
    manager.send(agent.id, { prompt: "Too late to steer" }),
    (err: unknown) =>
      err instanceof ExecutorError && err.code === "status_mismatch",
  );
  assert.equal(exec.commands.get(agent.id)?.length, 1);

  exec.complete(agent.id, "Round 1");
  await until(() => manager.get(agent.id).status === "completed");
});

test("resume rejects when native terminal is blocked for user interaction", async (t) => {
  useAgentDir(t);
  const exec = createTestExecutor();
  const manager = createSubagentManager(exec.executor, {
    extensionAllowlist: [],
  });
  t.after(() => manager.close());

  const agent = manager.spawn(task);
  await until(() => exec.commands.get(agent.id)?.length === 1);
  await manager.openView(agent.id);
  exec.complete(agent.id, "Round 1");
  await until(() => manager.get(agent.id).status === "completed");

  exec.setBlocked(agent.id, "Permission prompt");
  await assert.rejects(
    manager.send(agent.id, { prompt: "Round 2" }),
    /Resume requires an idle session/,
  );
  assert.equal(exec.commands.get(agent.id)?.length, 1);
});

test("executeTurn keeps waiting when executor.wait returns early working check-in", async (t) => {
  useAgentDir(t);
  const exec = createTestExecutor();
  const manager = createSubagentManager(exec.executor, {
    extensionAllowlist: [],
  });
  t.after(() => manager.close());

  const agent = manager.spawn(task);
  await until(() => exec.commands.get(agent.id)?.length === 1);

  // Simulate Herdr 180s timeout / message check-in while worker is still working
  exec.checkIn(agent.id);
  await delay(15);
  assert.equal(manager.get(agent.id).status, "running");

  exec.complete(agent.id, "Finished after check-in");
  await until(() => manager.get(agent.id).status === "completed");
  assert.equal(manager.get(agent.id).result, "Finished after check-in");
});

test("completing without an open view releases the worker even when supportsView is true", async (t) => {
  useAgentDir(t);
  const exec = createTestExecutor(true);
  const manager = createSubagentManager(exec.executor, {
    extensionAllowlist: [],
  });
  t.after(() => manager.close());

  const agent = manager.spawn(task);
  await until(() => exec.commands.get(agent.id)?.length === 1);
  exec.complete(agent.id, "Done without view");
  await until(() => manager.get(agent.id).status === "completed");
  await until(() => exec.destroyed.length === 1);
  assert.equal(manager.get(agent.id).sessionState, "closed");
});

test("in-flight openView protects worker from idle auto-close and closeView triggers release", async (t) => {
  useAgentDir(t);
  const exec = createTestExecutor(true);
  let resolveOpen: ((view: { id: string }) => void) | undefined;
  let openCalls = 0;
  exec.executor.open_view = ({ terminal }) => {
    openCalls += 1;
    return new Promise((resolve) => {
      resolveOpen = () => resolve({ id: `view-${terminal.id}` });
    });
  };
  const manager = createSubagentManager(exec.executor, {
    extensionAllowlist: [],
  });
  t.after(() => manager.close());

  const agent = manager.spawn(task);
  await until(() => exec.commands.get(agent.id)?.length === 1);

  const firstOpen = manager.openView(agent.id);
  const secondOpen = manager.openView(agent.id);
  assert.equal(firstOpen, secondOpen);
  assert.equal(manager.get(agent.id).viewId, undefined);

  exec.complete(agent.id, "Done while opening view");
  await until(() => manager.get(agent.id).status === "completed");
  await delay(15);
  assert.equal(exec.destroyed.length, 0);

  await until(() => resolveOpen !== undefined);
  resolveOpen?.({ id: `view-${agent.id}` });
  const view = await firstOpen;
  assert.equal(view.id, `view-${agent.id}`);
  assert.equal(openCalls, 1);
  assert.equal(manager.get(agent.id).viewId, `view-${agent.id}`);
  assert.equal(exec.destroyed.length, 0);

  await manager.closeView(agent.id);
  await until(() => exec.destroyed.length === 1);
  assert.equal(manager.get(agent.id).sessionState, "closed");
});

test("failed openView clears pending view and releases an already-settled idle worker", async (t) => {
  useAgentDir(t);
  const exec = createTestExecutor(true);
  let rejectOpen: ((error: Error) => void) | undefined;
  exec.executor.open_view = () =>
    new Promise((_resolve, reject) => {
      rejectOpen = reject;
    });
  const manager = createSubagentManager(exec.executor, {
    extensionAllowlist: [],
  });
  t.after(() => manager.close());

  const agent = manager.spawn(task);
  await until(() => exec.commands.get(agent.id)?.length === 1);

  const pendingOpen = manager.openView(agent.id);
  exec.complete(agent.id, "Done before open failed");
  await until(() => manager.get(agent.id).status === "completed");
  await delay(15);
  assert.equal(exec.destroyed.length, 0);

  await until(() => rejectOpen !== undefined);
  rejectOpen?.(new Error("Tab creation failed"));
  await assert.rejects(pendingOpen, /Tab creation failed/);
  await until(() => exec.destroyed.length === 1);
  assert.equal(manager.get(agent.id).sessionState, "closed");
});
