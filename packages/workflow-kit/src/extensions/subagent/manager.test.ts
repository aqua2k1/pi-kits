import assert from "node:assert/strict";
import { connect, type Socket } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { useAgentDir } from "../../test-utils/agent-dir.ts";
import { parseAgentDefinition } from "./agents.ts";
import { SubagentManager } from "./manager.ts";
import type {
  MuxAdapter,
  OpenViewOptions,
  StartOptions,
  TerminalHandle,
  ViewHandle,
} from "./mux.ts";

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

  emit(id: string, event: object) {
    this.sockets.get(id)?.write(`${JSON.stringify(event)}\n`);
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
        promptMode: "replace",
        tools: ["read", "grep"],
      },
    },
  ]);
  assert.equal(agent.subagentType, "review");
  assert.equal(agent.displayName, "Reviewer");
  assert.equal(agent.agentSource, "project");
});

test("empty agent tools disable all tools and append mode retains normal context selection", async (t) => {
  const mux = new FakeMux();
  const manager = new SubagentManager(mux);
  t.after(() => manager.close());
  const agent = manager.spawn({
    ...task,
    agent: parseAgentDefinition(
      "---\ntools: none\nprompt_mode: append\n---\nInstructions",
      "/agents/empty.md",
      "global",
    ),
  });
  await until(() => mux.commands.get(agent.id)?.length === 1);
  assert.ok(mux.started[0].argv.includes("--no-tools"));
  assert.ok(!mux.started[0].argv.includes("--no-context-files"));
});

test("explicit extension allowlists replace defaults, including an empty list", async (t) => {
  for (const extensionAllowlist of [
    [],
    ["builtin:mcp", "/trusted/custom.ts"],
  ]) {
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

test("extension paths resolve from the agent directory, never the task cwd", async (t) => {
  const agentDir = useAgentDir(t);
  const mux = new FakeMux();
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
