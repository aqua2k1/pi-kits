import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  DefaultPackageManager,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { useAgentDir } from "../../tests/helpers/agent-dir.ts";
import { parseAgentDefinition } from "./agents.ts";
import { captureParentSession } from "./clone.ts";
import { SubagentManager } from "./manager.ts";
import type {
  MuxAdapter,
  OpenViewOptions,
  StartOptions,
  TerminalHandle,
  ViewHandle,
} from "./mux.ts";

test("model metadata replaces requested defaults and tracks idle, stats and resumed workers", async (t) => {
  const mux = new FakeMux();
  const emit = mux.emit.bind(mux);
  t.mock.method(mux, "emit", (id: string, event: Record<string, unknown>) =>
    emit(
      id,
      event.type === "ready"
        ? { ...event, model: "actual/ready", modelName: "Ready Model" }
        : event,
    ),
  );
  const manager = new SubagentManager(mux);
  t.after(() => manager.close());
  const agent = parseAgentDefinition(
    "---\nmodel: agent/requested\n---\nRole",
    "/agents/model.md",
    "global",
  );
  const first = manager.spawn({ ...task, model: "parent/default", agent });
  assert.equal(first.model, "agent/requested");
  const fallback = manager.spawn({ ...task, model: "parent/default" });
  assert.equal(fallback.model, "parent/default");
  await until(() => mux.commands.get(first.id)?.length === 1);
  assert.equal(manager.get(first.id).model, "actual/ready");
  assert.equal(manager.get(first.id).modelName, "Ready Model");
  mux.emit(first.id, {
    type: "stats",
    model: "actual/stats",
    modelName: "Stats Model",
  });
  await until(() => manager.get(first.id).model === "actual/stats");
  mux.emit(first.id, { type: "completed", result: "Done" });
  await until(() => manager.get(first.id).status === "completed");
  mux.emit(first.id, {
    type: "model_select",
    model: "actual/idle",
    modelName: "Idle Model",
  });
  await until(() => manager.get(first.id).model === "actual/idle");
  mux.emit(first.id, {
    type: "session_state",
    state: "idle",
    model: "actual/native",
    modelName: "Native Model",
  });
  await until(() => manager.get(first.id).model === "actual/native");
  const resumed = manager.resume(first.id, { prompt: "Next" });
  assert.equal(resumed.model, "actual/native");
  assert.equal(resumed.modelName, "Native Model");
  await until(() => mux.commands.get(first.id)?.length === 2);
  mux.emit(first.id, { type: "model_select", round: 1, model: "stale/model" });
  mux.emit(first.id, {
    type: "stats",
    model: ["bad"],
    modelName: 42,
    turnCount: 2,
  });
  await until(() => manager.get(first.id).turnCount === 2);
  assert.equal(manager.get(first.id).model, "actual/native");
  assert.equal(manager.get(first.id).modelName, "Native Model");
  mux.emit(first.id, { type: "model_select", model: "actual/unnamed" });
  await until(() => manager.get(first.id).model === "actual/unnamed");
  assert.equal(manager.get(first.id).modelName, undefined);
});

class FakeMux implements MuxAdapter {
  readonly started: StartOptions[] = [];
  readonly commands = new Map<string, Record<string, unknown>[]>();
  readonly sockets = new Map<string, Socket>();
  readonly destroyed: string[] = [];
  readonly closedViews: string[] = [];
  readonly focused: string[] = [];
  readonly opened: OpenViewOptions[] = [];
  readonly missingViews = new Set<string>();
  authenticate = true;

  check_env() {
    return true;
  }

  async start(options: StartOptions): Promise<TerminalHandle> {
    this.started.push(options);
    const [host, port] = options.env.PI_KITS_SUBAGENT_ENDPOINT.split(":");
    const socket = connect({ host, port: Number(port) });
    this.sockets.set(options.agentId, socket);
    this.commands.set(options.agentId, []);
    socket.setEncoding("utf8");
    socket.on("error", () => undefined);
    socket.on("connect", () => {
      this.emit(options.agentId, {
        type: "ready",
        id: options.agentId,
        token: this.authenticate
          ? options.env.PI_KITS_SUBAGENT_TOKEN
          : "wrong-token",
        sessionPath: "/tmp/worker-session.jsonl",
      });
    });
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        this.commands
          .get(options.agentId)
          ?.push(JSON.parse(buffer.slice(0, newline)));
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
      }
    });
    return { id: options.agentId };
  }

  emit(id: string, event: Record<string, unknown>) {
    const command = this.commands
      .get(id)
      ?.findLast((item) => item.type === "task");
    const frame =
      event.type === "ready" || event.type === "session_state"
        ? event
        : { round: command?.round, ...event };
    this.sockets.get(id)?.write(`${JSON.stringify(frame)}\n`);
  }

  async inspect(): Promise<{ alive: boolean }> {
    return { alive: true };
  }

  async destroy(handle: TerminalHandle) {
    this.destroyed.push(handle.id);
    this.sockets.get(handle.id)?.destroy();
  }

  async open_view(options: OpenViewOptions): Promise<ViewHandle> {
    this.opened.push(options);
    return { id: `view-${options.terminal.id}-${this.opened.length}` };
  }

  async inspect_view(view: ViewHandle) {
    return {
      alive:
        !this.missingViews.has(view.id) && !this.closedViews.includes(view.id),
    };
  }

  async focus_view(view: ViewHandle) {
    this.focused.push(view.id);
  }

  async close_view(view: ViewHandle) {
    this.closedViews.push(view.id);
  }
}

async function until(check: () => boolean) {
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

test("inheritance opens one native cloned session, keeps IPC small and never reclones on resume", async (t) => {
  useAgentDir(t);
  const parent = SessionManager.inMemory(task.cwd);
  parent.appendMessage({
    role: "user",
    content: "secret".repeat(20000),
    timestamp: 1,
  });
  const mux = new FakeMux();
  const manager = new SubagentManager(mux);
  t.after(() => manager.close());
  const agent = manager.spawn({
    ...task,
    parentSession: captureParentSession(parent),
  });
  await until(() => mux.commands.get(agent.id)?.length === 1);
  const argv = mux.started[0].argv;
  assert.ok(argv.includes("--session"));
  assert.ok(!argv.includes("--session-id"));
  const file = argv[argv.indexOf("--session") + 1];
  const cloned = SessionManager.open(file);
  assert.equal(cloned.getSessionId(), `subagent-${agent.id}`);
  assert.deepEqual(
    cloned.buildSessionProjection().messages,
    parent.buildSessionProjection().messages,
  );
  assert.equal(manager.get(agent.id).inheritedContext, true);
  assert.deepEqual(mux.commands.get(agent.id), [
    { type: "task", prompt: task.prompt },
  ]);
  mux.emit(agent.id, { type: "completed", result: "Done" });
  await until(() => manager.get(agent.id).status === "completed");
  manager.resume(agent.id, { prompt: "Continue" });
  await until(() => mux.commands.get(agent.id)?.length === 2);
  assert.equal(mux.started.length, 1);
  assert.deepEqual(mux.commands.get(agent.id)?.[1], {
    type: "task",
    prompt: "Continue",
    round: 2,
  });
});

test("deletion settles waiters, removes queued work and cleans up views without deleting session files", async (t) => {
  useAgentDir(t);
  const mux = new FakeMux();
  const notifications: string[] = [];
  const manager = new SubagentManager(mux, {
    maxConcurrent: 1,
    onComplete: (agent) => notifications.push(agent.id),
  });
  t.after(() => manager.close());
  const parent = SessionManager.inMemory(task.cwd);
  parent.appendMessage({ role: "user", content: "Keep me", timestamp: 1 });
  const running = manager.spawn({
    ...task,
    parentSession: captureParentSession(parent),
  });
  await until(() => manager.get(running.id).status === "running");
  const sessionPath =
    mux.started[0].argv[mux.started[0].argv.indexOf("--session") + 1];
  assert.ok(existsSync(sessionPath));
  const view = await manager.openView(running.id);
  const queued = manager.spawn(task);
  const queuedWait = manager.result(queued.id, true);
  await manager.remove(queued.id);
  assert.equal((await queuedWait).status, "stopped");
  assert.throws(() => manager.get(queued.id), /Unknown subagent/);
  const runningWait = manager.result(running.id, true);
  await manager.remove(running.id);
  assert.equal((await runningWait).status, "stopped");
  assert.deepEqual(manager.list(), []);
  assert.deepEqual(mux.closedViews, [view.id]);
  assert.ok(mux.destroyed.includes(running.id));
  assert.ok(existsSync(sessionPath));
  assert.equal(mux.started.length, 1);
  assert.deepEqual(notifications, []);
  const next = manager.spawn(task);
  await until(() => manager.get(next.id).status === "running");
});

test("deletion during delayed startup waits for late terminal cleanup", async (t) => {
  const mux = new FakeMux();
  const original = mux.start.bind(mux);
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered = false;
  t.mock.method(mux, "start", async (options: StartOptions) => {
    entered = true;
    await gate;
    return original(options);
  });
  const manager = new SubagentManager(mux, { maxConcurrent: 1 });
  t.after(() => manager.close());
  const agent = manager.spawn(task);
  await until(() => entered);
  const queued = manager.spawn(task);
  // Removing a sibling must not wait for this blocked startup.
  await manager.remove(queued.id);
  assert.throws(() => manager.get(queued.id), /Unknown subagent/);
  manager.stop(agent.id);
  const waiting = manager.result(agent.id, true);
  const removing = manager.remove(agent.id);
  release();
  await removing;
  assert.equal((await waiting).status, "stopped");
  assert.deepEqual(manager.list(), []);
  assert.ok(mux.destroyed.includes(agent.id));
});

test("failed deletion retains terminal ownership and can be retried", async (t) => {
  const mux = new FakeMux();
  const manager = new SubagentManager(mux, { maxConcurrent: 1 });
  t.after(() => manager.close());
  const agent = manager.spawn(task);
  await until(() => manager.get(agent.id).status === "running");
  const destroy = mux.destroy.bind(mux);
  t.mock.method(mux, "destroy", async () => {
    throw new Error("Failed");
  });
  await assert.rejects(manager.remove(agent.id), /retry deletion/);
  assert.equal(manager.get(agent.id).terminalId, agent.id);
  const next = manager.spawn(task);
  assert.equal(manager.get(next.id).status, "queued");
  t.mock.method(mux, "destroy", destroy);
  await manager.remove(agent.id);
  assert.throws(() => manager.get(agent.id), /Unknown subagent/);
  await until(() => manager.get(next.id).status === "running");
});

test("manager is lazy, starts an authenticated worker and returns structured results", async (t) => {
  const mux = new FakeMux();
  const notifications: string[] = [];
  const manager = new SubagentManager(mux, {
    onComplete: (record) => notifications.push(record.id),
  });
  t.after(() => manager.close());
  assert.equal(mux.started.length, 0);
  const updates: string[] = [];
  const unsubscribe = manager.subscribe(() => {
    updates.push(manager.list()[0]?.status ?? "empty");
  });
  manager.subscribe(() => {
    throw new Error("Broken UI subscriber");
  });
  const agent = manager.spawn({ ...task, model: "sonnet", thinking: "high" });
  await until(() => mux.commands.get(agent.id)?.length === 1);
  const start = mux.started[0];
  assert.equal(start.env.PI_KITS_SUBAGENT_WORKER, "1");
  assert.ok(start.argv.includes("--no-approve"));
  assert.ok(start.argv.includes("--no-extensions"));
  assert.equal(start.argv.filter((arg) => arg === "-e").length, 3);
  assert.ok(start.argv.includes("sonnet"));
  assert.deepEqual(mux.commands.get(agent.id), [
    { type: "task", prompt: task.prompt },
  ]);
  assert.equal(manager.get(agent.id).sessionPath, "/tmp/worker-session.jsonl");
  manager.steer(agent.id, "Only inspect files");
  await until(() => mux.commands.get(agent.id)?.length === 2);
  assert.deepEqual(mux.commands.get(agent.id)?.[1], {
    type: "steer",
    message: "Only inspect files",
  });
  mux.emit(agent.id, {
    type: "stats",
    turnCount: 2,
    toolUses: 3,
    totalTokens: 1234,
    compactionCount: 1,
    contextPercent: 42,
  });
  await until(() => manager.get(agent.id).turnCount === 2);
  assert.equal(manager.get(agent.id).toolUses, 3);
  assert.equal(manager.get(agent.id).totalTokens, 1234);
  assert.equal(manager.get(agent.id).contextPercent, 42);
  mux.emit(agent.id, {
    type: "stats",
    turnCount: -1,
    toolUses: 1.5,
    totalTokens: Number.MAX_SAFE_INTEGER + 1,
    contextPercent: 101,
  });
  await until(() => manager.get(agent.id).contextPercent === undefined);
  assert.equal(manager.get(agent.id).turnCount, 2);
  assert.equal(manager.get(agent.id).toolUses, 3);
  assert.equal(manager.get(agent.id).totalTokens, 1234);
  mux.emit(agent.id, { type: "activity", toolName: "read" });
  await until(() => manager.get(agent.id).activity === "read");
  const result = manager.result(agent.id, true);
  mux.emit(agent.id, { type: "completed", result: "Found auth.ts" });
  assert.equal((await result).result, "Found auth.ts");
  assert.equal(manager.get(agent.id).status, "completed");
  assert.deepEqual(notifications, [], "Waited results must not notify twice");
  assert.ok(updates.includes("starting"));
  assert.ok(updates.includes("running"));
  assert.ok(updates.includes("completed"));
  const finished = manager.get(agent.id);
  assert.ok(finished.startedAt !== undefined);
  assert.ok(finished.completedAt !== undefined);
  assert.ok(finished.completedAt >= finished.startedAt);
  unsubscribe();
});

test("finished tasks retain results while native session state continues changing", async (t) => {
  const mux = new FakeMux();
  const notifications: string[] = [];
  const manager = new SubagentManager(mux, {
    onComplete: (record) => notifications.push(record.id),
  });
  t.after(() => manager.close());
  const agent = manager.spawn(task);
  await until(() => mux.commands.get(agent.id)?.length === 1);
  assert.equal(manager.get(agent.id).sessionState, "running");
  mux.emit(agent.id, { type: "completed", result: "Original result" });
  await until(() => manager.get(agent.id).status === "completed");
  const finished = manager.get(agent.id);
  assert.equal(finished.sessionState, "idle");
  await manager.openView(agent.id);
  assert.equal(manager.get(agent.id).sessionState, "idle");
  mux.emit(agent.id, {
    type: "session_state",
    state: "interactive",
    activity: "read",
  });
  await until(() => manager.get(agent.id).sessionState === "interactive");
  const manual = manager.get(agent.id);
  assert.equal(manual.status, "completed");
  assert.equal(manual.result, finished.result);
  assert.equal(manual.completedAt, finished.completedAt);
  assert.equal(manual.sessionActivity, "read");
  mux.emit(agent.id, { type: "stats", turnCount: 100 });
  mux.emit(agent.id, { type: "completed", result: "Manual result" });
  mux.emit(agent.id, { type: "session_state", state: "idle" });
  await until(() => manager.get(agent.id).sessionState === "idle");
  assert.equal(manager.get(agent.id).result, "Original result");
  assert.equal(manager.get(agent.id).turnCount, finished.turnCount);
  assert.equal(manager.get(agent.id).sessionActivity, undefined);
  assert.deepEqual(notifications, [agent.id]);
  mux.sockets.get(agent.id)?.destroy();
  await until(() => manager.get(agent.id).sessionState === "disconnected");
  assert.equal(manager.get(agent.id).status, "completed");
  assert.equal(manager.get(agent.id).result, "Original result");
  await manager.close();
  assert.equal(manager.get(agent.id).sessionState, "closed");
});

test("malformed session states fail the authenticated connection closed", async (t) => {
  const mux = new FakeMux();
  const manager = new SubagentManager(mux);
  t.after(() => manager.close());
  const agent = manager.spawn(task);
  await until(() => mux.commands.get(agent.id)?.length === 1);
  mux.emit(agent.id, { type: "session_state", state: ["idle"] });
  assert.equal((await manager.result(agent.id, true)).status, "error");
  assert.equal(manager.get(agent.id).sessionState, "closed");
});

test("named agent configuration controls worker argv and structured system instructions", async (t) => {
  const mux = new FakeMux();
  const manager = new SubagentManager(mux);
  t.after(() => manager.close());
  const definition = parseAgentDefinition(
    `---\nmodel: agent-model\nthinking: high\ntools: read, grep\ndisallowed_tools: write\ndisplay_name: Reviewer\n---\nSystem instructions`,
    "/project/.pi/agents/review.md",
    "project",
  );
  const agent = manager.spawn({
    ...task,
    agent: definition,
    model: "call-model",
    thinking: "low",
  });
  await until(() => mux.commands.get(agent.id)?.length === 1);
  const argv = mux.started[0].argv;
  assert.equal(argv[argv.indexOf("--model") + 1], "agent-model");
  assert.equal(argv[argv.indexOf("--thinking") + 1], "high");
  assert.equal(argv[argv.indexOf("--tools") + 1], "read,grep");
  assert.equal(argv[argv.indexOf("--exclude-tools") + 1], "write");
  assert.ok(argv.includes("--no-context-files"));
  assert.ok(argv.includes("--no-extensions"));
  assert.ok(argv.includes("builtin:codemode"));
  assert.ok(argv.includes("builtin:tool-search"));
  assert.deepEqual(mux.commands.get(agent.id), [
    {
      type: "task",
      prompt: task.prompt,
      instructions: {
        systemPrompt: "System instructions",
        tools: ["read", "grep"],
      },
    },
  ]);
  assert.equal(agent.subagentType, "review");
  assert.equal(agent.displayName, "Reviewer");
  assert.equal(agent.agentSource, "project");
});

test("empty agent tools disable all tools and named agents always disable context file discovery", async (t) => {
  const mux = new FakeMux();
  const manager = new SubagentManager(mux);
  t.after(() => manager.close());
  const agent = manager.spawn({
    ...task,
    agent: parseAgentDefinition(
      "---\ntools: none\n---\nInstructions",
      "/agents/empty.md",
      "global",
    ),
  });
  await until(() => mux.commands.get(agent.id)?.length === 1);
  assert.ok(mux.started[0].argv.includes("--no-tools"));
  assert.ok(mux.started[0].argv.includes("--no-context-files"));
});

test("explicit extension allowlists replace defaults, including an empty list", async (t) => {
  const agentDir = useAgentDir(t);
  const custom = join(agentDir, "custom.ts");
  writeFileSync(custom, "export default () => {};");
  for (const extensionAllowlist of [[], ["builtin:mcp", custom]]) {
    const mux = new FakeMux();
    const manager = new SubagentManager(mux, { extensionAllowlist });
    t.after(() => manager.close());
    const agent = manager.spawn(task);
    await until(() => mux.commands.get(agent.id)?.length === 1);
    const argv = mux.started[0].argv;
    const extensions = argv.flatMap((arg, i) =>
      arg === "-e" ? [argv[i + 1]] : [],
    );
    assert.equal(extensions.length, extensionAllowlist.length + 1);
    assert.deepEqual(extensions.slice(1), extensionAllowlist);
    assert.ok(!argv.includes("builtin:codemode"));
    assert.ok(!argv.includes("builtin:tool-search"));
    assert.ok(argv.includes("--no-extensions"));
  }
});

test("package logical selections load only their declared resources in the worker", async (t) => {
  const dir = useAgentDir(t);
  const root = join(dir, "named-package");
  mkdirSync(root);
  const selected = join(root, "selected.ts");
  writeFileSync(selected, "export default () => {};");
  writeFileSync(join(root, "other.ts"), "export default () => {};");
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({
      pi: { extensions: ["./selected.ts", "./other.ts"] },
      extensionResources: { "custom-name": "./selected.ts" },
    }),
  );
  const mux = new FakeMux();
  const manager = new SubagentManager(mux, {
    extensionAllowlist: [
      { source: "named-package", extensions: ["custom-name"] },
    ],
  });
  t.after(() => manager.close());
  const agent = manager.spawn(task);
  await until(() => mux.commands.get(agent.id)?.length === 1);
  const argv = mux.started[0].argv;
  assert.ok(argv.includes(selected));
  assert.ok(!argv.includes(join(root, "other.ts")));
});

test("extension paths resolve from the agent directory, never the task cwd", async (t) => {
  const agentDir = useAgentDir(t);
  const mux = new FakeMux();
  const home = process.env.HOME;
  process.env.HOME = agentDir;
  t.after(() => {
    if (home === undefined) delete process.env.HOME;
    else process.env.HOME = home;
  });
  mkdirSync(join(agentDir, "extensions"));
  writeFileSync(
    join(agentDir, "extensions/custom file.ts"),
    "export default () => {};",
  );
  writeFileSync(join(agentDir, "trusted.ts"), "export default () => {};");
  const manager = new SubagentManager(mux, {
    extensionAllowlist: ["extensions/custom file.ts", "~/trusted.ts"],
  });
  t.after(() => manager.close());
  const agent = manager.spawn({ ...task, cwd: "/untrusted/project" });
  await until(() => mux.commands.get(agent.id)?.length === 1);
  const argv = mux.started[0].argv;
  assert.ok(argv.includes(join(agentDir, "extensions/custom file.ts")));
  assert.ok(argv.includes(join(homedir(), "trusted.ts")));
  assert.ok(!argv.includes("/untrusted/project/extensions/custom file.ts"));
});

test("stopping during native source resolution never starts a terminal afterwards", async (t) => {
  useAgentDir(t);
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered = false;
  t.mock.method(
    DefaultPackageManager.prototype,
    "resolveExtensionSources",
    async () => {
      entered = true;
      await waiting;
      return {
        extensions: [{ path: "/native/resolved.ts", enabled: true }],
        skills: [],
        prompts: [],
        themes: [],
      };
    },
  );
  const mux = new FakeMux();
  const manager = new SubagentManager(mux, {
    extensionAllowlist: ["native-source"],
  });
  t.after(() => manager.close());
  const agent = manager.spawn(task);
  await until(() => entered);
  await manager.stop(agent.id);
  release();
  await delay(20);
  assert.equal(mux.started.length, 0);
  assert.equal(manager.get(agent.id).status, "stopped");
});

test("oversized agent instructions fail before worker creation", () => {
  const mux = new FakeMux();
  const manager = new SubagentManager(mux);
  assert.throws(
    () =>
      manager.spawn({
        ...task,
        agent: parseAgentDefinition(
          "x".repeat(64 * 1024),
          "/agents/large.md",
          "global",
        ),
      }),
    /64 KiB protocol limit/,
  );
  assert.equal(mux.started.length, 0);
  assert.equal(manager.list().length, 0);
});

test("background completion notifies once and remains readable", async (t) => {
  const mux = new FakeMux();
  let notifications = 0;
  const manager = new SubagentManager(mux, {
    onComplete: () => {
      notifications += 1;
    },
  });
  t.after(() => manager.close());
  const { id } = manager.spawn(task);
  await until(() => mux.commands.get(id)?.length === 1);
  mux.emit(id, { type: "completed", result: "Done" });
  await until(() => manager.get(id).status === "completed");
  mux.emit(id, { type: "completed", result: "Duplicate" });
  assert.equal((await manager.result(id)).result, "Done");
  assert.equal(notifications, 1);
});

test("queue enforces concurrency and canceled queued tasks never start", async (t) => {
  const mux = new FakeMux();
  const manager = new SubagentManager(mux, { maxConcurrent: 1 });
  t.after(() => manager.close());
  const first = manager.spawn(task);
  const canceled = manager.spawn(task);
  const next = manager.spawn(task);
  assert.equal(canceled.status, "queued");
  assert.equal(manager.stop(canceled.id).status, "stopped");
  await until(() => mux.commands.get(first.id)?.length === 1);
  assert.equal(mux.started.length, 1);
  mux.emit(first.id, { type: "completed", result: "Done" });
  await until(() => mux.commands.get(next.id)?.length === 1);
  assert.equal(mux.started.length, 2);
  assert.ok(!mux.started.some((start) => start.agentId === canceled.id));
});

test("shared manager lays out concurrent views right then down for every adapter", async (t) => {
  const mux = new FakeMux();
  const manager = new SubagentManager(mux);
  t.after(() => manager.close());
  const agents = Array.from({ length: 3 }, () => manager.spawn(task));
  await until(() =>
    agents.every(({ id }) => mux.commands.get(id)?.length === 1),
  );
  const [first, second, third] = await Promise.all(
    agents.map(({ id }) => manager.openView(id)),
  );
  assert.deepEqual(mux.opened, [
    { terminal: { id: agents[0].id }, direction: "right" },
    { terminal: { id: agents[1].id }, direction: "down", relativeTo: first },
    { terminal: { id: agents[2].id }, direction: "down", relativeTo: second },
  ]);
  await manager.openView(agents[0].id);
  assert.equal(mux.opened.length, 3, "Focusing must not change stack order");
  assert.deepEqual(mux.focused, [first.id]);
  await manager.closeView(agents[1].id);
  const reopened = await manager.openView(agents[1].id);
  assert.deepEqual(mux.opened.at(-1), {
    terminal: { id: agents[1].id },
    direction: "down",
    relativeTo: third,
  });
  await manager.closeView(agents[1].id);
  mux.missingViews.add(third.id);
  await manager.openView(agents[1].id);
  assert.deepEqual(mux.opened.at(-1), {
    terminal: { id: agents[1].id },
    direction: "down",
    relativeTo: first,
  });
  assert.equal(manager.get(agents[2].id).viewId, undefined);
  assert.ok(mux.closedViews.includes(third.id));
  assert.ok(mux.closedViews.includes(reopened.id));
  await manager.closeView(agents[0].id);
  await manager.closeView(agents[1].id);
  await manager.openView(agents[2].id);
  assert.deepEqual(mux.opened.at(-1), {
    terminal: { id: agents[2].id },
    direction: "right",
  });
});

test("failed view creation does not occupy a slot or block other agents", async (t) => {
  const mux = new FakeMux();
  const manager = new SubagentManager(mux);
  t.after(() => manager.close());
  const first = manager.spawn(task);
  const second = manager.spawn(task);
  await until(() => mux.commands.get(second.id)?.length === 1);
  const open = mux.open_view.bind(mux);
  let fail = true;
  mux.open_view = async (options) => {
    if (fail) {
      fail = false;
      throw new Error("Split failed");
    }
    return open(options);
  };
  await assert.rejects(manager.openView(first.id), /Split failed/);
  const view = await manager.openView(second.id);
  await manager.openView(first.id);
  assert.deepEqual(mux.opened, [
    { terminal: { id: second.id }, direction: "right" },
    { terminal: { id: first.id }, direction: "down", relativeTo: view },
  ]);
});

test("view closure detaches without destroying the worker", async (t) => {
  const mux = new FakeMux();
  const manager = new SubagentManager(mux);
  t.after(() => manager.close());
  const { id } = manager.spawn(task);
  await until(() => mux.commands.get(id)?.length === 1);
  const view = await manager.openView(id);
  assert.equal(manager.get(id).viewId, view.id);
  await manager.openView(id);
  assert.deepEqual(mux.focused, [view.id]);
  await manager.closeView(id);
  assert.equal(manager.get(id).viewId, undefined);
  assert.deepEqual(mux.closedViews, [view.id]);
  assert.deepEqual(mux.destroyed, []);
  assert.equal(manager.get(id).status, "running");
});

test("disconnect and startup timeout produce errors rather than terminal-screen results", async (t) => {
  const mux = new FakeMux();
  const manager = new SubagentManager(mux);
  t.after(() => manager.close());
  const { id } = manager.spawn(task);
  await until(() => mux.commands.get(id)?.length === 1);
  const result = manager.result(id, true);
  mux.sockets.get(id)?.destroy();
  assert.equal((await result).status, "error");

  const badMux = new FakeMux();
  badMux.authenticate = false;
  const rejected = new SubagentManager(badMux, { startupTimeoutMs: 30 });
  t.after(() => rejected.close());
  const bad = rejected.spawn(task);
  const failure = await rejected.result(bad.id, true);
  assert.equal(failure.status, "error");
  assert.match(failure.error ?? "", /Timed out/);
  assert.equal(badMux.commands.get(bad.id)?.length, 0);
});

test("wait cancellation leaves the background worker running", async (t) => {
  const mux = new FakeMux();
  const manager = new SubagentManager(mux);
  t.after(() => manager.close());
  const { id } = manager.spawn(task);
  await until(() => mux.commands.get(id)?.length === 1);
  const controller = new AbortController();
  const wait = manager.result(id, true, controller.signal);
  controller.abort(new Error("Canceled wait"));
  await assert.rejects(wait, /Canceled wait/);
  assert.equal(manager.get(id).status, "running");
  assert.deepEqual(mux.destroyed, []);
});

test("shutdown is idempotent and rejects further work", async () => {
  const mux = new FakeMux();
  const manager = new SubagentManager(mux);
  const { id } = manager.spawn(task);
  await until(() => mux.commands.get(id)?.length === 1);
  await manager.close();
  await manager.close();
  assert.deepEqual(mux.destroyed, [id]);
  assert.throws(() => manager.spawn(task), /closed/);
  assert.throws(() => manager.get("missing"), /Unknown subagent/);
});

test("resume reuses identity, terminal, view and agent configuration with fresh per-round results", async (t) => {
  const mux = new FakeMux();
  const notifications: number[] = [];
  const manager = new SubagentManager(mux, {
    onComplete: (snapshot) => notifications.push(snapshot.round ?? 0),
  });
  t.after(() => manager.close());
  const agent = parseAgentDefinition(
    "---\nmodel: agent/model\ntools: []\nrun_in_background: false\n---\nKeep original role",
    "/agents/review.md",
    "global",
  );
  const first = manager.spawn({ ...task, agent });
  await until(() => mux.commands.get(first.id)?.length === 1);
  await manager.openView(first.id);
  mux.emit(first.id, {
    type: "stats",
    turnCount: 9,
    toolUses: 7,
    totalTokens: 123,
    compactionCount: 2,
    contextPercent: 80,
  });
  mux.emit(first.id, { type: "completed", result: "First", truncated: true });
  await until(() => manager.get(first.id).status === "completed");
  const original = manager.get(first.id);
  const next = manager.resume(first.id, {
    prompt: "Continue from history",
    description: "Follow-up",
  });
  assert.equal(next.round, 2);
  assert.equal(next.id, original.id);
  assert.equal(next.terminalId, original.terminalId);
  assert.equal(next.viewId, original.viewId);
  assert.equal(next.sessionPath, original.sessionPath);
  assert.equal(next.subagentType, original.subagentType);
  assert.equal(next.description, "Follow-up");
  assert.equal(next.result, undefined);
  assert.equal(next.completedAt, undefined);
  assert.equal(next.truncated, undefined);
  assert.equal(next.turnCount, 0);
  assert.equal(next.contextPercent, undefined);
  assert.equal(manager.backgroundPreference(first.id), false);
  await until(() => mux.commands.get(first.id)?.length === 2);
  assert.equal(mux.started.length, 1, "No new process or CLI configuration");
  assert.deepEqual(mux.commands.get(first.id)?.[1], {
    ...mux.commands.get(first.id)?.[0],
    prompt: "Continue from history",
    round: 2,
  });
  const waiter = manager.result(first.id, true);
  mux.emit(first.id, { type: "completed", result: "Second" });
  assert.equal((await waiter).result, "Second");
  assert.deepEqual(
    notifications,
    [1],
    "Foreground resumed round must not notify",
  );
  manager.resume(first.id, { prompt: "Third" });
  await until(() => mux.commands.get(first.id)?.length === 3);
  mux.emit(first.id, { type: "completed", result: "Third" });
  await until(() => manager.get(first.id).status === "completed");
  assert.deepEqual(
    notifications,
    [1, 3],
    "Background rounds notify independently",
  );
  assert.deepEqual(mux.destroyed, []);
});

test("resume rejects active, interactive, disconnected, closed and invalid tasks without changing prior results", async (t) => {
  const mux = new FakeMux();
  const manager = new SubagentManager(mux);
  t.after(() => manager.close());
  const first = manager.spawn(task);
  assert.throws(
    () => manager.resume(first.id, { prompt: "Again" }),
    /finished/,
  );
  await until(() => mux.commands.get(first.id)?.length === 1);
  mux.emit(first.id, { type: "completed", result: "Keep me" });
  await until(() => manager.get(first.id).status === "completed");
  assert.throws(() => manager.resume(first.id, { prompt: " " }), /blank/);
  assert.throws(
    () => manager.resume(first.id, { prompt: "x".repeat(70000) }),
    /64 KiB/,
  );
  assert.equal(manager.get(first.id).round, 1);
  mux.emit(first.id, { type: "session_state", state: "interactive" });
  await until(() => manager.get(first.id).sessionState === "interactive");
  assert.throws(() => manager.resume(first.id, { prompt: "Again" }), /idle/);
  assert.equal(manager.get(first.id).result, "Keep me");
  mux.sockets.get(first.id)?.destroy();
  await until(() => manager.get(first.id).sessionState === "disconnected");
  assert.throws(
    () => manager.resume(first.id, { prompt: "Again" }),
    /connected/,
  );
  assert.equal(manager.get(first.id).result, "Keep me");
  assert.equal(mux.started.length, 1);
  await manager.close();
  assert.throws(() => manager.resume(first.id, { prompt: "Again" }), /closed/);
});

test("resume shares FIFO concurrency and canceling a queued round cannot resurrect its queue entry", async (t) => {
  const mux = new FakeMux();
  const manager = new SubagentManager(mux, { maxConcurrent: 1 });
  t.after(() => manager.close());
  const first = manager.spawn(task);
  await until(() => mux.commands.get(first.id)?.length === 1);
  mux.emit(first.id, { type: "completed", result: "First" });
  await until(() => manager.get(first.id).status === "completed");
  const blocker = manager.spawn(task);
  await until(() => mux.commands.get(blocker.id)?.length === 1);
  assert.equal(
    manager.resume(first.id, { prompt: "Canceled" }).status,
    "queued",
  );
  const canceled = manager.result(first.id, true);
  manager.stop(first.id);
  assert.equal((await canceled).status, "stopped");
  const ahead = manager.spawn(task);
  manager.resume(first.id, { prompt: "Third" });
  mux.emit(blocker.id, { type: "completed", result: "Blocker" });
  await until(() => mux.commands.get(ahead.id)?.length === 1);
  assert.equal(mux.commands.get(first.id)?.length, 1);
  mux.emit(ahead.id, { type: "completed", result: "Ahead" });
  await until(() => mux.commands.get(first.id)?.length === 2);
  assert.equal(mux.commands.get(first.id)?.[1].round, 3);
  assert.equal(mux.commands.get(first.id)?.[1].prompt, "Third");
  assert.equal(mux.started.length, 3);
});

test("native work beginning while resume is queued rejects dispatch without canceling the user", async (t) => {
  const mux = new FakeMux();
  const manager = new SubagentManager(mux, { maxConcurrent: 1 });
  t.after(() => manager.close());
  const first = manager.spawn(task);
  await until(() => mux.commands.get(first.id)?.length === 1);
  mux.emit(first.id, { type: "completed", result: "First" });
  await until(() => manager.get(first.id).status === "completed");
  const blocker = manager.spawn(task);
  await until(() => mux.commands.get(blocker.id)?.length === 1);
  manager.resume(first.id, { prompt: "Waited continuation" });
  mux.emit(first.id, { type: "session_state", state: "interactive" });
  await until(() => manager.get(first.id).sessionState === "interactive");
  mux.emit(blocker.id, { type: "completed", result: "Blocker" });
  const result = await manager.result(first.id, true);
  assert.equal(result.status, "error");
  assert.match(result.error ?? "", /native\/user interaction/);
  assert.equal(result.sessionState, "interactive");
  assert.equal(mux.commands.get(first.id)?.length, 1);
  assert.deepEqual(mux.destroyed, []);
});

test("old waiters and late round events never consume or finish a resumed round", async (t) => {
  const mux = new FakeMux();
  const notifications: number[] = [];
  const manager = new SubagentManager(mux, {
    onComplete: (snapshot) => notifications.push(snapshot.round ?? 0),
  });
  t.after(() => manager.close());
  const first = manager.spawn(task);
  await until(() => mux.commands.get(first.id)?.length === 1);
  const oldWaiter = manager.result(first.id, true);
  const unsubscribe = manager.subscribe(() => {
    if (
      manager.get(first.id).round === 1 &&
      manager.get(first.id).status === "completed"
    ) {
      manager.resume(first.id, { prompt: "Next" });
    }
  });
  mux.emit(first.id, { type: "completed", result: "Old result" });
  const old = await oldWaiter;
  unsubscribe();
  assert.equal(old.round, 1);
  assert.equal(old.result, "Old result");
  await until(() => mux.commands.get(first.id)?.length === 2);
  mux.emit(first.id, { type: "stats", round: 1, turnCount: 99 });
  mux.emit(first.id, { type: "completed", round: 1, result: "Stale result" });
  mux.emit(first.id, {
    type: "completed",
    round: undefined,
    result: "Unscoped stale result",
  });
  mux.emit(first.id, { type: "session_state", round: 1, state: "interactive" });
  mux.emit(first.id, { type: "stats", turnCount: 2 });
  await until(() => manager.get(first.id).turnCount === 2);
  assert.equal(manager.get(first.id).status, "running");
  assert.equal(manager.get(first.id).result, undefined);
  assert.notEqual(manager.get(first.id).sessionState, "interactive");
  mux.emit(first.id, { type: "completed", result: "New result" });
  await until(() => manager.get(first.id).status === "completed");
  assert.deepEqual(
    notifications,
    [2],
    "Old waiter cannot suppress the new round notification",
  );
});

test("stopped and errored retained workers resume; missing terminals do not restart", async (t) => {
  const mux = new FakeMux();
  const manager = new SubagentManager(mux);
  t.after(() => manager.close());
  const first = manager.spawn(task);
  await until(() => mux.commands.get(first.id)?.length === 1);
  mux.emit(first.id, { type: "completed", canceled: true, result: "Canceled" });
  await until(() => manager.get(first.id).status === "stopped");
  manager.resume(first.id, { prompt: "Retry" });
  await until(() => mux.commands.get(first.id)?.length === 2);
  mux.emit(first.id, {
    type: "completed",
    result: "",
    error: "Provider error",
  });
  await until(() => manager.get(first.id).status === "error");
  t.mock.method(mux, "inspect", async () => ({ alive: false }));
  manager.resume(first.id, { prompt: "No restart" });
  assert.equal((await manager.result(first.id, true)).status, "error");
  assert.equal(mux.started.length, 1);
  assert.deepEqual(mux.destroyed, []);
});

test("cancel before resume inspection finishes never sends a task or kills the retained process", async (t) => {
  const mux = new FakeMux();
  const manager = new SubagentManager(mux);
  t.after(() => manager.close());
  const first = manager.spawn(task);
  await until(() => mux.commands.get(first.id)?.length === 1);
  mux.emit(first.id, { type: "completed", result: "First" });
  await until(() => manager.get(first.id).status === "completed");
  let release = () => {};
  t.mock.method(
    mux,
    "inspect",
    () =>
      new Promise<{ alive: boolean }>((resolve) => {
        release = () => resolve({ alive: true });
      }),
  );
  manager.resume(first.id, { prompt: "Canceled before dispatch" });
  assert.equal(manager.stop(first.id).status, "stopped");
  release();
  await delay(10);
  assert.equal(mux.commands.get(first.id)?.length, 1);
  assert.deepEqual(mux.destroyed, []);
});

test("unacknowledged resume cancellation never kills native work and retains the concurrency claim", async (t) => {
  const mux = new FakeMux();
  const manager = new SubagentManager(mux, {
    maxConcurrent: 1,
    cancelTimeoutMs: 5,
  });
  t.after(() => manager.close());
  const first = manager.spawn(task);
  await until(() => mux.commands.get(first.id)?.length === 1);
  mux.emit(first.id, { type: "completed", result: "First" });
  await until(() => manager.get(first.id).status === "completed");
  manager.resume(first.id, { prompt: "Resume awaiting acceptance" });
  await until(() => mux.commands.get(first.id)?.length === 2);
  manager.stop(first.id);
  await until(() => manager.get(first.id).status === "disconnected");
  const queued = manager.spawn(task);
  assert.equal(manager.get(queued.id).status, "queued");
  assert.deepEqual(mux.destroyed, []);
  mux.emit(first.id, { type: "completed", result: "", canceled: true });
  await until(() => mux.commands.get(queued.id)?.length === 1);
});

test("accepted resume cancellation may clean up an unresponsive owned worker", async (t) => {
  const mux = new FakeMux();
  const manager = new SubagentManager(mux, {
    cancelTimeoutMs: 5,
  });
  t.after(() => manager.close());
  const first = manager.spawn(task);
  await until(() => mux.commands.get(first.id)?.length === 1);
  mux.emit(first.id, { type: "completed", result: "First" });
  await until(() => manager.get(first.id).status === "completed");
  manager.resume(first.id, { prompt: "Accepted continuation" });
  await until(() => mux.commands.get(first.id)?.length === 2);
  mux.emit(first.id, { type: "session_state", state: "running", round: 2 });
  await until(() => manager.get(first.id).sessionState === "running");
  const waiter = manager.result(first.id, true);
  manager.stop(first.id);
  assert.equal((await waiter).status, "stopped");
  assert.equal(manager.get(first.id).sessionState, "closed");
  assert.deepEqual(mux.destroyed, [first.id]);
  assert.throws(
    () => manager.resume(first.id, { prompt: "No restart" }),
    /connected/,
  );
});

test("connection loss before resume acknowledgement preserves the worker and concurrency claim", async (t) => {
  const mux = new FakeMux();
  const manager = new SubagentManager(mux, { maxConcurrent: 1 });
  t.after(() => manager.close());
  const first = manager.spawn(task);
  await until(() => mux.commands.get(first.id)?.length === 1);
  mux.emit(first.id, { type: "completed", result: "First" });
  await until(() => manager.get(first.id).status === "completed");
  manager.resume(first.id, { prompt: "Unconfirmed continuation" });
  await until(() => mux.commands.get(first.id)?.length === 2);
  mux.sockets.get(first.id)?.destroy();
  await until(() => manager.get(first.id).status === "disconnected");
  assert.deepEqual(mux.destroyed, []);
  const next = manager.spawn(task);
  assert.equal(manager.get(next.id).status, "queued");
  assert.equal(manager.stop(first.id).status, "disconnected");
  assert.deepEqual(mux.destroyed, []);
});

test("a stale cancellation timer cannot change a later resumed round", async (t) => {
  const mux = new FakeMux();
  const manager = new SubagentManager(mux);
  t.after(() => manager.close());
  const first = manager.spawn(task);
  await until(() => mux.commands.get(first.id)?.length === 1);
  mux.emit(first.id, { type: "completed", result: "First" });
  await until(() => manager.get(first.id).status === "completed");
  manager.resume(first.id, { prompt: "Second" });
  await until(() => mux.commands.get(first.id)?.length === 2);
  const timeout = globalThis.setTimeout;
  let expired = () => {};
  t.mock.method(
    globalThis,
    "setTimeout",
    (callback: () => void, ms?: number) => {
      expired = callback;
      return timeout(callback, ms);
    },
  );
  manager.stop(first.id);
  mux.emit(first.id, { type: "completed", canceled: true, result: "" });
  await until(() => manager.get(first.id).status === "stopped");
  manager.resume(first.id, { prompt: "Third" });
  await until(() => mux.commands.get(first.id)?.at(-1)?.round === 3);
  expired();
  assert.equal(manager.get(first.id).status, "running");
  assert.deepEqual(mux.destroyed, []);
});

test("resume cannot race an already-started terminal cleanup after cooperative completion", async (t) => {
  const mux = new FakeMux();
  const manager = new SubagentManager(mux, { cancelTimeoutMs: 5 });
  t.after(() => manager.close());
  const first = manager.spawn(task);
  await until(() => mux.commands.get(first.id)?.length === 1);
  mux.emit(first.id, { type: "completed", result: "First" });
  await until(() => manager.get(first.id).status === "completed");
  manager.resume(first.id, { prompt: "Second" });
  await until(() => mux.commands.get(first.id)?.length === 2);
  mux.emit(first.id, { type: "session_state", state: "running", round: 2 });
  await until(() => manager.get(first.id).sessionState === "running");
  let release = () => {};
  let destroying = false;
  const destroy = mux.destroy.bind(mux);
  t.mock.method(mux, "destroy", async (handle: TerminalHandle) => {
    destroying = true;
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    await destroy(handle);
  });
  manager.stop(first.id);
  await until(() => destroying);
  try {
    mux.emit(first.id, { type: "completed", canceled: true, result: "" });
    await until(() => manager.get(first.id).status === "stopped");
    assert.throws(
      () => manager.resume(first.id, { prompt: "Unsafe restart" }),
      /cleanup/,
    );
    assert.equal(manager.get(first.id).round, 2);
  } finally {
    release();
  }
  await until(() => manager.get(first.id).sessionState === "closed");
});

test("Pi disconnect is one-shot: an unconfirmed resume cannot reauthenticate or release native ownership", async (t) => {
  const mux = new FakeMux();
  const manager = new SubagentManager(mux, { maxConcurrent: 1 });
  t.after(() => manager.close());
  const first = manager.spawn(task);
  await until(() => mux.commands.get(first.id)?.length === 1);
  mux.emit(first.id, { type: "completed", result: "First" });
  await until(() => manager.get(first.id).status === "completed");
  manager.resume(first.id, { prompt: "Unconfirmed resume" });
  await until(() => mux.commands.get(first.id)?.length === 2);
  mux.sockets.get(first.id)?.destroy();
  await until(() => manager.get(first.id).status === "disconnected");
  const start = mux.started[0];
  const [host, port] = start.env.PI_KITS_SUBAGENT_ENDPOINT.split(":");
  const replacement = connect({ host, port: Number(port) });
  t.after(() => replacement.destroy());
  replacement.on("error", () => undefined);
  replacement.on("connect", () => {
    replacement.write(
      `${JSON.stringify({
        type: "ready",
        id: first.id,
        token: start.env.PI_KITS_SUBAGENT_TOKEN,
      })}\n`,
    );
  });
  await until(() => replacement.destroyed);
  assert.equal(manager.get(first.id).status, "disconnected");
  assert.equal(manager.get(first.id).sessionState, "disconnected");
  assert.deepEqual(mux.destroyed, []);
  const queued = manager.spawn(task);
  assert.equal(queued.status, "queued");
});

test("startup cancellation does not wait for another agent's blocked view operation", async (t) => {
  useAgentDir(t);
  let releaseResolution = () => {};
  let releaseView = () => {};
  let resolutions = 0;
  const resolving = new Promise<void>((resolve) => {
    releaseResolution = resolve;
  });
  const viewing = new Promise<void>((resolve) => {
    releaseView = resolve;
  });
  t.mock.method(
    DefaultPackageManager.prototype,
    "resolveExtensionSources",
    async () => {
      resolutions++;
      if (resolutions > 1) await resolving;
      return {
        extensions: [{ path: "/native/resolved.ts", enabled: true }],
        skills: [],
        prompts: [],
        themes: [],
      };
    },
  );
  const mux = new FakeMux();
  const manager = new SubagentManager(mux, {
    extensionAllowlist: ["native-source"],
  });
  t.after(async () => {
    releaseResolution();
    releaseView();
    await manager.close();
  });
  const first = manager.spawn(task);
  await until(() => mux.commands.get(first.id)?.length === 1);
  const open = mux.open_view.bind(mux);
  let viewEntered = false;
  t.mock.method(mux, "open_view", async (options: OpenViewOptions) => {
    viewEntered = true;
    await viewing;
    return open(options);
  });
  const opening = manager.openView(first.id);
  await until(() => viewEntered);
  const canceled = manager.spawn(task);
  await until(() => resolutions === 2);
  assert.equal(manager.stop(canceled.id).status, "stopping");
  releaseResolution();
  await delay(20);
  assert.equal(mux.started.length, 1);
  releaseView();
  await opening;
  assert.equal((await manager.result(canceled.id, true)).status, "stopped");
});
