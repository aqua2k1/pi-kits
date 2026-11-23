import assert from "node:assert/strict";
import { connect, type Socket } from "node:net";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { Executor, StartOptions } from "./execute/index.ts";
import { createSubagentManager } from "./manager.ts";

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
  const executor: Executor = {
    id: "herdr-core",
    supportsView: true,
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
    executor,
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
  const h = harness();
  let notifications = 0;
  const manager = createSubagentManager(h.executor, {
    extensionAllowlist: [],
    onComplete: () => {
      notifications += 1;
    },
  });
  t.after(() => manager.close());
  const { id } = manager.spawn(task);
  await until(() => h.prompts.includes(id));
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
  const h = harness();
  const manager = createSubagentManager(h.executor, {
    maxConcurrent: 1,
    extensionAllowlist: [],
  });
  t.after(() => manager.close());
  const first = manager.spawn(task);
  const next = manager.spawn(task);
  await until(() => h.prompts.includes(first.id));
  assert.equal(manager.stop(first.id).status, "stopping");
  await delay(10);
  assert.deepEqual(h.starts, [first.id]);
  h.complete(first.id, true);
  await until(() => h.prompts.includes(next.id));
  assert.equal(manager.get(first.id).status, "stopped");
});

test("IPC disconnect retains the slot until cleanup succeeds; stop retries failures", async (t) => {
  const h = harness();
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
  await until(() => h.prompts.includes(first.id));
  h.sockets.get(first.id)?.destroy();
  await until(() => manager.get(first.id).status === "disconnected");
  assert.deepEqual(h.starts, [first.id]);
  canDestroy = true;
  manager.stop(first.id);
  await until(() => h.prompts.includes(next.id));
  assert.equal(manager.get(first.id).status, "stopped");
  assert.deepEqual(h.destroyed, [first.id]);
});
