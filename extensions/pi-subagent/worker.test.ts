import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { Socket } from "node:net";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import workerExtension, {
  isSubagentWorker,
  MAX_COMMAND_BYTES,
  MAX_RESULT_BYTES,
  parseWorkerCommand,
  readWorkerConfig,
  registerWorkerBridge,
  type WorkerCommand,
  type WorkerConfig,
  type WorkerEvent,
} from "./worker.ts";

const config: WorkerConfig = {
  host: "127.0.0.1",
  port: 32123,
  token: "random-manager-token",
  id: "sub-1",
};

type Handler = (
  event: Record<string, unknown>,
  ctx: ExtensionContext,
) => unknown;

function createFakeSocket() {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    destroyed: false,
    frames: [] as WorkerEvent[],
    setNoDelay(): void {},
    unref(): void {},
    write(frame: string): boolean {
      this.frames.push(JSON.parse(frame) as WorkerEvent);
      return true;
    },
    destroy(): void {
      this.destroyed = true;
      emitter.emit("close");
    },
    command(command: WorkerCommand): void {
      emitter.emit("data", Buffer.from(`${JSON.stringify(command)}\n`));
    },
  });
}

function harness(connect?: (config: WorkerConfig) => Socket) {
  const handlers = new Map<string, Handler>();
  const sockets: ReturnType<typeof createFakeSocket>[] = [];
  const messages: Array<{ text: string; deliverAs?: string }> = [];
  let aborts = 0;
  let shutdowns = 0;
  let terminations = 0;
  const ctx = {
    mode: "tui",
    isIdle: () => true,
    model: { provider: "test", id: "test-model", name: "Test Model" },
    sessionManager: {
      getSessionFile: () => "/sessions/worker.jsonl",
    },
    abort() {
      aborts += 1;
    },
    shutdown() {
      shutdowns += 1;
    },
  } as unknown as ExtensionContext;
  const pi = {
    on(name: string, handler: Handler) {
      handlers.set(name, handler);
      return () => handlers.delete(name);
    },
    sendUserMessage(text: string, options?: { deliverAs?: string }) {
      messages.push({ text, deliverAs: options?.deliverAs });
    },
  } as unknown as ExtensionAPI;
  registerWorkerBridge(pi, config, {
    terminate() {
      terminations += 1;
    },
    connect(value) {
      if (connect) return connect(value);
      const socket = createFakeSocket();
      sockets.push(socket);
      return socket as unknown as Socket;
    },
  });
  return {
    pi,
    ctx,
    sockets,
    messages,
    get aborts() {
      return aborts;
    },
    get shutdowns() {
      return shutdowns;
    },
    get terminations() {
      return terminations;
    },
    emit(name: string, fields: Record<string, unknown> = {}) {
      const handler = handlers.get(name);
      assert.ok(handler, `Missing handler ${name}`);
      return handler({ type: name, ...fields }, ctx);
    },
    start() {
      this.emit("session_start");
      const socket = sockets.at(-1);
      assert.ok(socket);
      socket.emit("connect");
      return socket;
    },
  };
}

function assistant(text: string, stopReason = "stop", errorMessage?: string) {
  return {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "not sent to manager" },
      { type: "text", text },
    ],
    stopReason,
    errorMessage,
  };
}

test("explicit worker marker and command parsing", () => {
  assert.equal(isSubagentWorker({ PI_KITS_SUBAGENT_WORKER: "1" }), true);
  assert.equal(isSubagentWorker({ PI_KITS_SUBAGENT_WORKER: "0" }), false);
  const env = {
    PI_KITS_SUBAGENT_WORKER: "1",
    PI_KITS_SUBAGENT_ENDPOINT: "127.0.0.1:32123",
    PI_KITS_SUBAGENT_TOKEN: config.token,
    PI_KITS_SUBAGENT_ID: config.id,
  };
  assert.deepEqual(readWorkerConfig(env), config);
  assert.deepEqual(parseWorkerCommand({ type: "task", prompt: "hello" }), {
    type: "task",
    prompt: "hello",
  });
  assert.deepEqual(
    parseWorkerCommand({ type: "steer", message: "focus", round: 2 }),
    { type: "steer", message: "focus", round: 2 },
  );
  assert.deepEqual(parseWorkerCommand({ type: "cancel" }), { type: "cancel" });
  assert.throws(() => parseWorkerCommand({ type: "task", prompt: "  " }));
  assert.equal(MAX_COMMAND_BYTES, 64 * 1024);
  assert.equal(MAX_RESULT_BYTES, 64 * 1024);
});

test("worker executes managed task, steering, native interaction, and cancellation", async () => {
  const h = harness();
  const socket = h.start();
  socket.command({ type: "task", prompt: "first task" });
  socket.command({ type: "steer", message: "focus" });
  h.emit("agent_start");
  assert.deepEqual(h.messages, [
    { text: "first task", deliverAs: "followUp" },
    { text: "focus", deliverAs: "steer" },
  ]);
  h.emit("tool_execution_start", { toolName: "read" });
  h.emit("message_end", {
    message: {
      ...assistant("final result"),
      usage: { input: 10, output: 5, cacheWrite: 2, cacheRead: 100 },
    },
  });
  h.emit("agent_settled");
  const completed = socket.frames.filter((f) => f.type === "completed");
  assert.equal(completed.length, 1);
  assert.equal(completed[0].result, "final result");

  // Native user interaction
  h.emit("before_agent_start");
  h.emit("agent_start");
  h.emit("message_end", { message: assistant("native answer") });
  h.emit("agent_settled");
  const updates = socket.frames.filter((f) => f.type === "session_update");
  assert.equal(updates.length, 1);
  assert.equal(updates[0].response, "native answer");

  // Cancellation
  socket.command({ type: "task", prompt: "second", round: 2 });
  h.emit("agent_start");
  socket.command({ type: "cancel", round: 2 });
  assert.equal(h.aborts, 1);
  h.emit("agent_settled");
  await setImmediate();
  assert.equal(
    socket.frames.filter((f) => f.type === "completed").at(-1)?.canceled,
    true,
  );
});

test("default extension is inert outside worker mode", (t) => {
  const original = process.env.PI_KITS_SUBAGENT_WORKER;
  process.env.PI_KITS_SUBAGENT_WORKER = "0";
  t.after(() => {
    if (original === undefined) delete process.env.PI_KITS_SUBAGENT_WORKER;
    else process.env.PI_KITS_SUBAGENT_WORKER = original;
  });
  workerExtension({
    on() {
      assert.fail("Disabled worker must not register handlers");
    },
  } as unknown as ExtensionAPI);
});
