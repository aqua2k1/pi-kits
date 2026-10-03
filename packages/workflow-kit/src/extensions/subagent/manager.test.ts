import assert from "node:assert/strict";
import { connect, type Socket } from "node:net";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { SubagentManager } from "./manager.ts";
import type {
  MuxAdapter,
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

  async open_view(options: {
    terminal: TerminalHandle;
    direction: "right" | "down";
  }): Promise<ViewHandle> {
    return { id: `view-${options.terminal.id}-${options.direction}` };
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
  const agent = manager.spawn({ ...task, model: "sonnet", thinking: "high" });
  await until(() => mux.commands.get(agent.id)?.length === 1);
  const start = mux.started[0];
  assert.equal(start.env.PI_KITS_SUBAGENT_WORKER, "1");
  assert.ok(start.argv.includes("--no-approve"));
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
  mux.emit(agent.id, { type: "activity", toolName: "read" });
  await until(() => manager.get(agent.id).activity === "read");
  const result = manager.result(agent.id, true);
  mux.emit(agent.id, { type: "completed", result: "Found auth.ts" });
  assert.equal((await result).result, "Found auth.ts");
  assert.equal(manager.get(agent.id).status, "completed");
  assert.deepEqual(notifications, [], "Waited results must not notify twice");
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

test("view closure detaches without destroying the worker", async (t) => {
  const mux = new FakeMux();
  const manager = new SubagentManager(mux);
  t.after(() => manager.close());
  const { id } = manager.spawn(task);
  await until(() => mux.commands.get(id)?.length === 1);
  const view = await manager.openView(id, "down");
  assert.equal(manager.get(id).viewId, view.id);
  await manager.openView(id, "right");
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
