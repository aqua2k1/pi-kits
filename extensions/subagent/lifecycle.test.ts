import assert from "node:assert/strict";
import { connect, type Socket } from "node:net";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { SubagentManager } from "./manager.ts";
import {
  type MuxAdapter,
  type StartOptions,
  TerminalStartError,
} from "./mux/index.ts";

const task = { prompt: "Inspect files", description: "Inspect", cwd: "/tmp" };

async function until(check: () => boolean) {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await delay(5);
  }
  assert.fail("Condition did not become true");
}

function harness() {
  const sockets = new Map<string, Socket>();
  const prompts: string[] = [];
  const destroyed: string[] = [];
  const starts: string[] = [];
  const adapter: MuxAdapter = {
    check_env: () => true,
    async start(options: StartOptions) {
      starts.push(options.agentId);
      const [host, port] = options.env.PI_KITS_SUBAGENT_ENDPOINT.split(":");
      const socket = connect({ host, port: Number(port) });
      sockets.set(options.agentId, socket);
      socket.on("error", () => undefined);
      socket.on("connect", () => {
        socket.write(
          `${JSON.stringify({
            type: "ready",
            id: options.agentId,
            token: options.env.PI_KITS_SUBAGENT_TOKEN,
          })}\n`,
        );
      });
      socket.on("data", (data) => {
        if (data.toString().includes('"type":"task"')) {
          prompts.push(options.agentId);
        }
      });
      return { id: options.agentId };
    },
    inspect: async () => ({ alive: true }),
    async destroy(terminal) {
      destroyed.push(terminal.id);
      sockets.get(terminal.id)?.destroy();
    },
    open_view: async () => ({ id: "view" }),
    inspect_view: async () => ({ alive: true }),
    focus_view: async () => undefined,
    close_view: async () => undefined,
  };
  return {
    adapter,
    sockets,
    starts,
    prompts,
    destroyed,
    complete(id: string, canceled = false) {
      const socket = sockets.get(id);
      socket?.write(
        `${JSON.stringify({ type: "completed", result: "Done", canceled })}\n`,
      );
    },
  };
}

test("canceling one result waiter does not release another waiter's notification claim", async (t) => {
  const mux = harness();
  let notifications = 0;
  const manager = new SubagentManager(mux.adapter, {
    onComplete: () => {
      notifications += 1;
    },
  });
  t.after(() => manager.close());
  const { id } = manager.spawn(task);
  await until(() => mux.prompts.includes(id));
  const controller = new AbortController();
  const canceled = manager.result(id, true, controller.signal);
  const remaining = manager.result(id, true);
  controller.abort(new Error("Canceled wait"));
  await assert.rejects(canceled, /Canceled wait/);
  mux.complete(id);
  assert.equal((await remaining).status, "completed");
  assert.equal(notifications, 0);
});

test("running cancellation retains its queue slot until the worker settles", async (t) => {
  const mux = harness();
  const manager = new SubagentManager(mux.adapter, { maxConcurrent: 1 });
  t.after(() => manager.close());
  const first = manager.spawn({ ...task, keepAlive: true });
  const next = manager.spawn({ ...task, keepAlive: true });
  await until(() => mux.prompts.includes(first.id));
  assert.equal(manager.stop(first.id).status, "stopping");
  await delay(10);
  assert.deepEqual(mux.starts, [first.id]);
  mux.complete(first.id, true);
  await until(() => mux.prompts.includes(next.id));
  assert.equal(manager.get(first.id).status, "stopped");
  assert.deepEqual(
    mux.destroyed,
    [],
    "Cooperative cancel retains the Pi terminal",
  );
});

test("shutdown awaits a mux startup and destroys its late-returning terminal", async () => {
  const mux = harness();
  const originalStart = mux.adapter.start.bind(mux.adapter);
  let release: () => void = () => undefined;
  let entered = false;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  mux.adapter.start = async (options) => {
    entered = true;
    await gate;
    return originalStart(options);
  };
  const manager = new SubagentManager(mux.adapter);
  const { id } = manager.spawn(task);
  await until(() => entered);
  const closing = manager.close();
  release();
  await closing;
  assert.deepEqual(mux.destroyed, [id]);
  assert.equal(manager.get(id).status, "stopped");
});

test("oversized task commands fail before creating a worker", async () => {
  const mux = harness();
  const manager = new SubagentManager(mux.adapter);
  assert.throws(
    () => manager.spawn({ ...task, prompt: "界".repeat(30_000) }),
    /64 KiB/,
  );
  assert.deepEqual(mux.starts, []);
  await manager.close();
});

test("IPC disconnect retains the slot until cleanup succeeds; stop retries failures", async (t) => {
  const mux = harness();
  const destroy = mux.adapter.destroy.bind(mux.adapter);
  let canDestroy = false;
  mux.adapter.destroy = async (terminal) => {
    if (!canDestroy) throw new Error("Server unavailable");
    await destroy(terminal);
  };
  const manager = new SubagentManager(mux.adapter, { maxConcurrent: 1 });
  t.after(async () => {
    canDestroy = true;
    await manager.close();
  });
  const first = manager.spawn(task);
  const next = manager.spawn(task);
  await until(() => mux.prompts.includes(first.id));
  mux.sockets.get(first.id)?.destroy();
  await until(() => manager.get(first.id).status === "disconnected");
  assert.deepEqual(mux.starts, [first.id]);
  canDestroy = true;
  manager.stop(first.id);
  await until(() => mux.prompts.includes(next.id));
  assert.equal(manager.get(first.id).status, "stopped");
  assert.deepEqual(mux.destroyed, [first.id]);
});

test("forced cancellation is stopped, not a disconnect error", async (t) => {
  const mux = harness();
  const manager = new SubagentManager(mux.adapter, { cancelTimeoutMs: 1 });
  t.after(() => manager.close());
  const { id } = manager.spawn(task);
  await until(() => mux.prompts.includes(id));
  manager.stop(id);
  const result = await manager.result(id, true);
  assert.equal(result.status, "stopped");
  assert.deepEqual(mux.destroyed, [id]);
});

test("concurrent view operations create one attachment and close it completely", async (t) => {
  const mux = harness();
  let opens = 0;
  const closed: string[] = [];
  mux.adapter.open_view = async () => {
    opens += 1;
    await delay(5);
    return { id: `view-${opens}` };
  };
  mux.adapter.close_view = async (view) => {
    closed.push(view.id);
  };
  const manager = new SubagentManager(mux.adapter);
  t.after(() => manager.close());
  const { id } = manager.spawn(task);
  await until(() => mux.prompts.includes(id));
  const [first, second] = await Promise.all([
    manager.openView(id),
    manager.openView(id),
  ]);
  assert.deepEqual(first, second);
  assert.equal(opens, 1);
  await manager.closeView(id);
  assert.deepEqual(closed, [first.id]);
  assert.deepEqual(mux.destroyed, []);
});

test("blank prompts and steering fail before changing the worker", async (t) => {
  const mux = harness();
  const manager = new SubagentManager(mux.adapter);
  t.after(() => manager.close());
  assert.throws(() => manager.spawn({ ...task, prompt: "  \n " }), /blank/);
  assert.deepEqual(mux.starts, []);
  const { id } = manager.spawn(task);
  await until(() => mux.prompts.includes(id));
  assert.throws(() => manager.steer(id, " \t "), /blank/);
  assert.equal(manager.get(id).status, "running");
});

test("failed startup rollback retains its handle and queue slot for cleanup retry", async (t) => {
  const mux = harness();
  const start = mux.adapter.start.bind(mux.adapter);
  const destroy = mux.adapter.destroy.bind(mux.adapter);
  let firstStart = true;
  let canDestroy = false;
  mux.adapter.start = async (options) => {
    const terminal = await start(options);
    if (firstStart) {
      firstStart = false;
      throw new TerminalStartError(terminal, new Error("CLI response lost"));
    }
    return terminal;
  };
  mux.adapter.destroy = async (terminal) => {
    if (!canDestroy) throw new Error("Cleanup unavailable");
    await destroy(terminal);
  };
  const manager = new SubagentManager(mux.adapter, { maxConcurrent: 1 });
  t.after(async () => {
    canDestroy = true;
    await manager.close();
  });
  const first = manager.spawn(task);
  const next = manager.spawn(task);
  await until(() => manager.get(first.id).status === "disconnected");
  assert.equal(manager.get(first.id).terminalId, first.id);
  assert.deepEqual(mux.starts, [first.id]);
  canDestroy = true;
  manager.stop(first.id);
  await until(() => mux.prompts.includes(next.id));
  assert.equal(manager.get(first.id).status, "stopped");
  assert.deepEqual(mux.destroyed, [first.id]);
});
