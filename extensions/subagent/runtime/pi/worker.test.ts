import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { createConnection, createServer, type Socket } from "node:net";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import workerExtension, {
  createWorkerJsonlReader,
  isSubagentWorker,
  MAX_COMMAND_BYTES,
  MAX_PENDING_COMMANDS,
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
  id: "worker-1",
};

type Handler = (
  event: Record<string, unknown>,
  ctx: ExtensionContext,
) => unknown;

class FakeSocket extends EventEmitter {
  destroyed = false;
  writableLength = 0;
  frames: WorkerEvent[] = [];
  setNoDelay(): void {}
  unref(): void {}
  write(frame: string): boolean {
    this.frames.push(JSON.parse(frame) as WorkerEvent);
    return true;
  }
  destroy(): void {
    this.destroyed = true;
    this.emit("close");
  }
  command(command: WorkerCommand): void {
    this.emit("data", Buffer.from(`${JSON.stringify(command)}\n`));
  }
}

function harness(connect?: (config: WorkerConfig) => Socket) {
  const handlers = new Map<string, Handler>();
  const sent = new EventEmitter();
  const sockets: FakeSocket[] = [];
  const messages: Array<{ text: string; deliverAs?: string }> = [];
  let aborts = 0;
  let shutdowns = 0;
  let terminations = 0;
  let connects = 0;
  let editor = "local unfinished draft";
  const ctx = {
    mode: "tui",
    isIdle: () => true,
    model: { provider: "test", id: "test-model", name: "Test Model" },
    modelRegistry: {
      hasConfiguredAuth: () => true,
    },
    sessionManager: {
      getSessionFile: () => "/sessions/worker.jsonl",
    },
    ui: {
      getEditorText: () => editor,
      setEditorText: (text: string) => {
        editor = text;
      },
    },
    abort() {
      aborts += 1;
      // Pi TUI's abort clears native queues and restores them in the editor.
      editor = "canceled native follow-up";
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
    getActiveTools: () => ["read", "codemode"],
    sendUserMessage(text: string, options?: { deliverAs?: string }) {
      messages.push({ text, deliverAs: options?.deliverAs });
      sent.emit("message");
    },
  } as unknown as ExtensionAPI;
  registerWorkerBridge(pi, config, {
    terminate() {
      terminations += 1;
    },
    connect(value) {
      connects += 1;
      if (connect) return connect(value);
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket as unknown as Socket;
    },
  });
  return {
    pi,
    ctx,
    sockets,
    messages,
    sent,
    get aborts() {
      return aborts;
    },
    get connects() {
      return connects;
    },
    get shutdowns() {
      return shutdowns;
    },
    get terminations() {
      return terminations;
    },
    get editor() {
      return editor;
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
      { type: "text", text: "second block" },
    ],
    stopReason,
    errorMessage,
  };
}

function completions(socket: FakeSocket) {
  return socket.frames.filter((frame) => frame.type === "completed");
}

test("actual model selection is reported while idle and in resumed tasks", () => {
  const h = harness();
  const socket = h.start();
  assert.ok(h.ctx.model);
  const model = {
    ...h.ctx.model,
    provider: "other",
    id: "actual",
    name: "Actual Model",
  };
  // The event is authoritative even if the supplied context still has the old model.
  h.emit("model_select", {
    model,
    source: "cycle",
    previousModel: h.ctx.model,
  });
  assert.deepEqual(socket.frames.at(-1), {
    type: "model_select",
    id: config.id,
    model: "other/actual",
    modelName: "Actual Model",
  });
  h.ctx.model = model;
  socket.command({ type: "task", prompt: "work", round: 1 });
  h.emit("agent_start");
  h.emit("message_end", { message: assistant("answer") });
  const stats = socket.frames.filter((frame) => frame.type === "stats").at(-1);
  assert.equal(stats?.model, "other/actual");
  assert.equal(stats?.modelName, "Actual Model");
  h.emit("agent_settled");
  h.ctx.model = { ...model, id: "next", name: "Next Model" };
  h.emit("model_select", { model: h.ctx.model, source: "restore" });
  socket.command({ type: "task", prompt: "resume", round: 2 });
  const state = socket.frames
    .filter((frame) => frame.type === "session_state")
    .at(-1);
  assert.equal(state?.model, "other/next");
  assert.equal(state?.modelName, "Next Model");
});

test("explicit worker marker and validated loopback environment", () => {
  for (const marker of [undefined, "", "0", "true"]) {
    const env = { PI_KITS_SUBAGENT_WORKER: marker };
    assert.equal(isSubagentWorker(env), false);
    assert.equal(readWorkerConfig(env), undefined);
  }
  const env = {
    PI_KITS_SUBAGENT_WORKER: "1",
    PI_KITS_SUBAGENT_ENDPOINT: "127.0.0.1:32123",
    PI_KITS_SUBAGENT_TOKEN: config.token,
    PI_KITS_SUBAGENT_ID: config.id,
  };
  assert.equal(isSubagentWorker(env), true);
  assert.deepEqual(readWorkerConfig(env), config);
  for (const endpoint of [
    "localhost:12",
    "0.0.0.0:12",
    "127.0.0.2:12",
    "127.0.0.1:0",
    "127.0.0.1:65536",
    "127.0.0.1:12/path",
    '{"host":"127.0.0.1","port":12}',
  ]) {
    assert.throws(() =>
      readWorkerConfig({ ...env, PI_KITS_SUBAGENT_ENDPOINT: endpoint }),
    );
  }
  assert.throws(() => readWorkerConfig({ ...env, PI_KITS_SUBAGENT_TOKEN: "" }));
  assert.throws(() => readWorkerConfig({ ...env, PI_KITS_SUBAGENT_ID: "" }));
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

test("JSONL handles split UTF-8, CRLF, Unicode separators and batches", () => {
  const received: WorkerCommand[] = [];
  const read = createWorkerJsonlReader((command) => received.push(command));
  const prompt = "中文🙂\u2028\u2029\nnext line";
  const bytes = Buffer.from(
    `${JSON.stringify({ type: "task", prompt })}\r\n` +
      `${JSON.stringify({ type: "steer", message: "focus" })}\n` +
      '{"type":"cancel"}\n',
  );
  for (const byte of bytes) read(Buffer.from([byte]));
  assert.deepEqual(received, [
    { type: "task", prompt },
    { type: "steer", message: "focus" },
    { type: "cancel" },
  ]);
});

test("JSONL is byte-bounded per frame, not per TCP chunk", () => {
  let count = 0;
  const read = createWorkerJsonlReader(() => count++, 20);
  read(Buffer.from('{"type":"cancel"}\n'.repeat(100)));
  assert.equal(count, 100);
  const incomplete = createWorkerJsonlReader(() => undefined, 10);
  incomplete(Buffer.from("123456"));
  assert.throws(() => incomplete(Buffer.from("78901")), /too large/);
  assert.throws(() => read(Buffer.from("x".repeat(21))), /too large/);
  const utf8 = createWorkerJsonlReader(() => undefined, 8);
  assert.throws(() => utf8(Buffer.from("中中中")), /too large/);
});

test("invalid JSON, UTF-8 and command shapes fail closed", () => {
  for (const frame of ["\n", "nope\n", "[]\n", "null\n"]) {
    assert.throws(() =>
      createWorkerJsonlReader(() => undefined)(Buffer.from(frame)),
    );
  }
  assert.throws(() =>
    createWorkerJsonlReader(() => undefined)(Buffer.from([0xff, 10])),
  );
  for (const value of [
    null,
    [],
    {},
    { type: "task", prompt: " " },
    { type: "task", prompt: 1 },
    { type: "steer", message: "" },
    { type: "unknown" },
  ]) {
    assert.throws(() => parseWorkerCommand(value));
  }
});

test("resources start only at TUI session_start; ready authenticates", () => {
  const h = harness();
  assert.equal(h.connects, 0);
  for (const mode of ["rpc", "json", "print"] as const) {
    h.ctx.mode = mode;
    h.emit("session_start");
  }
  assert.equal(h.connects, 0);
  h.ctx.mode = "tui";
  const socket = h.start();
  assert.deepEqual(socket.frames, [
    {
      type: "ready",
      id: config.id,
      token: config.token,
      sessionPath: "/sessions/worker.jsonl",
      model: "test/test-model",
      modelName: "Test Model",
    },
    {
      type: "session_state",
      id: config.id,
      state: "idle",
      model: "test/test-model",
      modelName: "Test Model",
    },
  ]);
  h.emit("session_shutdown");
  h.emit("session_shutdown");
  assert.equal(socket.destroyed, true);
});

test("busy task/followUp and steer delivery, with only settled completion", () => {
  const h = harness();
  const socket = h.start();
  socket.command({ type: "task", prompt: "first task" });
  socket.command({ type: "task", prompt: "follow-up" });
  socket.command({ type: "steer", message: "focus" });
  assert.equal(h.messages.length, 1, "startup prompts must not race");
  h.emit("agent_start");
  assert.deepEqual(h.messages, [
    { text: "first task", deliverAs: "followUp" },
    { text: "follow-up", deliverAs: "followUp" },
    { text: "focus", deliverAs: "steer" },
  ]);
  h.emit("message_end", { message: assistant("transient", "error", "retry") });
  h.emit("agent_end");
  assert.deepEqual(completions(socket), []);
  h.emit("agent_start");
  h.emit("message_end", { message: assistant("final result") });
  h.emit("agent_end");
  assert.deepEqual(completions(socket), []);
  h.emit("agent_settled");
  h.emit("agent_settled");
  assert.deepEqual(completions(socket), [
    {
      type: "completed",
      id: config.id,
      result: "final result\nsecond block",
      sessionPath: "/sessions/worker.jsonl",
    },
  ]);
  assert.equal(socket.frames.filter((f) => f.type === "started").length, 1);
  assert.equal(JSON.stringify(socket.frames).includes(config.token), true);
  assert.equal(
    JSON.stringify(socket.frames.slice(1)).includes(config.token),
    false,
  );
});

test("worker leaves CLI system prompts intact in managed and native turns", () => {
  const h = harness();
  const socket = h.start();
  const before = () => h.emit("before_agent_start", { systemPrompt: "base" });
  socket.command({
    type: "task",
    prompt: "work",
    instructions: {
      systemPrompt: "Custom instructions",
    },
  });
  assert.equal(before(), undefined);
  h.emit("agent_settled");
  assert.equal(before(), undefined);
  h.emit("agent_settled");
  socket.command({
    type: "task",
    prompt: "work",
    instructions: {
      systemPrompt: "New role",
    },
  });
  assert.equal(before(), undefined);
  h.emit("agent_settled");
  socket.command({ type: "task", prompt: "ordinary task" });
  assert.equal(before(), undefined);
});

test("native conversations publish interactive/idle without producing task results or stats", () => {
  const h = harness();
  const socket = h.start();
  socket.command({ type: "task", prompt: "first" });
  h.emit("agent_start");
  h.emit("message_end", { message: assistant("Original result") });
  h.emit("agent_settled");
  const original = completions(socket)[0];
  const stats = socket.frames.filter((frame) => frame.type === "stats").length;
  h.emit("before_agent_start", { systemPrompt: "base" });
  h.emit("agent_start");
  h.emit("tool_execution_start", { toolName: "read" });
  assert.deepEqual(socket.frames.at(-1), {
    type: "session_state",
    id: config.id,
    state: "interactive",
    activity: "read",
    model: "test/test-model",
    modelName: "Test Model",
  });
  h.emit("tool_execution_end", { toolName: "read" });
  h.emit("message_end", { message: assistant("Manual result") });
  h.emit("agent_end");
  assert.equal(socket.frames.at(-1)?.type, "session_state");
  assert.deepEqual(completions(socket), [original]);
  h.emit("agent_settled");
  assert.deepEqual(socket.frames.at(-1), {
    type: "session_state",
    id: config.id,
    state: "idle",
    model: "test/test-model",
    modelName: "Test Model",
  });
  assert.deepEqual(completions(socket), [original]);
  assert.equal(
    socket.frames.filter((frame) => frame.type === "stats").length,
    stats,
  );
});

test("IPC tasks cannot take over native work, and task cancellation does not abort it", () => {
  const h = harness();
  const socket = h.start();
  h.emit("before_agent_start", { systemPrompt: "base" });
  socket.command({ type: "task", prompt: "Do not interrupt" });
  assert.equal(h.messages.length, 0);
  assert.match(
    completions(socket)[0].error ?? "",
    /busy with user interaction/,
  );
  socket.command({ type: "cancel" });
  assert.equal(h.aborts, 0);
  h.emit("agent_settled");
  socket.command({ type: "task", prompt: "Now idle" });
  assert.equal(h.messages.length, 1);
});

test("round numbers are validated and survive parsing for every control command", () => {
  assert.deepEqual(
    parseWorkerCommand({ type: "task", prompt: "next", round: 2 }),
    {
      type: "task",
      prompt: "next",
      round: 2,
    },
  );
  assert.deepEqual(
    parseWorkerCommand({ type: "steer", message: "guidance", round: 2 }),
    {
      type: "steer",
      message: "guidance",
      round: 2,
    },
  );
  assert.deepEqual(parseWorkerCommand({ type: "cancel", round: 2 }), {
    type: "cancel",
    round: 2,
  });
  for (const round of [0, -1, 1.5, "2", null, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => parseWorkerCommand({ type: "cancel", round }), /round/);
  }
});

test("resumed round events are scoped and stale cancellation cannot interrupt a new round", () => {
  const h = harness();
  const socket = h.start();
  socket.command({ type: "task", prompt: "first" });
  h.emit("agent_start");
  h.emit("message_end", { message: assistant("First") });
  h.emit("agent_settled");
  socket.command({ type: "task", prompt: "second", round: 2 });
  h.emit("agent_start");
  socket.command({ type: "cancel", round: 1 });
  socket.command({ type: "cancel" });
  socket.command({ type: "steer", message: "old guidance", round: 1 });
  socket.command({ type: "task", prompt: "old replay", round: 1 });
  assert.equal(h.aborts, 0);
  assert.equal(h.messages.length, 2);
  h.emit("message_end", { message: assistant("Second") });
  h.emit("agent_settled");
  assert.equal(completions(socket)[1].round, 2);
  assert.equal(completions(socket)[1].result, "Second\nsecond block");
  const stats = socket.frames.filter((frame) => frame.type === "stats").at(-1);
  assert.equal(stats?.round, 2);
  assert.equal(stats?.turnCount, 1, "Statistics start fresh");
  h.emit("before_agent_start", { systemPrompt: "base" });
  assert.deepEqual(socket.frames.at(-1), {
    type: "session_state",
    id: config.id,
    state: "interactive",
    activity: "Thinking…",
    model: "test/test-model",
    modelName: "Test Model",
  });
  socket.command({ type: "task", prompt: "old replay", round: 2 });
  socket.command({ type: "task", prompt: "legacy replay" });
  assert.equal(completions(socket).length, 2);
  socket.command({
    type: "task",
    prompt: "Cannot steal native work",
    round: 3,
  });
  assert.equal(completions(socket)[2].round, 3);
  assert.match(completions(socket)[2].error ?? "", /user interaction/);
  socket.command({ type: "cancel", round: 3 });
  assert.equal(h.aborts, 0);
  h.emit("agent_settled");
  socket.command({ type: "task", prompt: "Fourth", round: 4 });
  h.emit("agent_start");
  socket.command({ type: "cancel", round: 4 });
  assert.equal(h.aborts, 1);
  h.emit("agent_settled");
  assert.equal(completions(socket)[3].round, 4);
  assert.equal(completions(socket)[3].canceled, true);
});

test("runtime busy without agent hooks rejects resume without permanently latching interactive", (t) => {
  const h = harness();
  const socket = h.start();
  let busy = true;
  t.mock.method(h.ctx, "isIdle", () => !busy);
  socket.command({ type: "task", prompt: "Busy", round: 2 });
  assert.equal(h.messages.length, 0);
  assert.match(completions(socket)[0].error ?? "", /busy/);
  busy = false;
  socket.command({ type: "task", prompt: "Now available", round: 3 });
  assert.equal(h.messages.length, 1);
  assert.equal(h.aborts, 0);
});

test("missing requested tools fail before a model turn instead of being ignored", () => {
  const h = harness();
  const socket = h.start();
  socket.command({
    type: "task",
    prompt: "work",
    instructions: {
      systemPrompt: "test",
      tools: ["web_search"],
    },
  });
  assert.equal(h.messages.length, 0);
  assert.match(
    completions(socket)[0].error ?? "",
    /web_search.*extensionAllowlist/,
  );
  socket.command({
    type: "task",
    prompt: "work",
    instructions: {
      systemPrompt: "test",
      tools: ["read", "codemode"],
    },
  });
  assert.equal(h.messages.length, 1);
});

test("worker rejects malformed instructions and accepts tools without a system prompt", () => {
  assert.deepEqual(
    parseWorkerCommand({
      type: "task",
      prompt: "work",
      instructions: { tools: ["read"] },
    }),
    { type: "task", prompt: "work", instructions: { tools: ["read"] } },
  );
  for (const instructions of [
    null,
    false,
    [],
    { systemPrompt: 42 },
    { systemPrompt: "x", tools: "codemode" },
    { systemPrompt: "x", tools: [false] },
  ]) {
    assert.throws(
      () => parseWorkerCommand({ type: "task", prompt: "work", instructions }),
      /Invalid worker instructions/,
    );
  }
});

test("worker reports cumulative turn/tool/token stats, excluding cacheRead", () => {
  const h = harness();
  const socket = h.start();
  h.ctx.getContextUsage = () =>
    ({ percent: 42 }) as ReturnType<ExtensionContext["getContextUsage"]>;
  socket.command({ type: "task", prompt: "work" });
  h.emit("agent_start");
  h.emit("tool_execution_start", { toolName: "read", toolCallId: "call" });
  const message = {
    ...assistant("answer"),
    usage: { input: 10, output: 5, cacheWrite: 2, cacheRead: 999 },
  };
  h.emit("message_end", { message });
  h.emit("session_compact");
  const stats = socket.frames.filter((frame) => frame.type === "stats");
  assert.deepEqual(stats.at(-1), {
    type: "stats",
    id: config.id,
    turnCount: 1,
    toolUses: 1,
    totalTokens: 17,
    contextPercent: 42,
    compactionCount: 1,
    model: "test/test-model",
    modelName: "Test Model",
  });
  h.emit("agent_settled");
  socket.command({ type: "task", prompt: "next task" });
  h.emit("agent_start");
  h.emit("message_end", { message });
  const next = socket.frames.filter((frame) => frame.type === "stats").at(-1);
  assert.equal(next?.totalTokens, 17);
  assert.equal(next?.toolUses, 0);
});

test("tool and finalized message events are structured, without raw payloads", () => {
  const h = harness();
  const socket = h.start();
  socket.command({ type: "task", prompt: "work" });
  h.emit("agent_start");
  h.emit("tool_execution_start", {
    toolName: "bash",
    toolCallId: "call/1",
    parentToolCallId: "call",
    args: { command: "secret" },
  });
  h.emit("tool_execution_end", {
    toolName: "bash",
    toolCallId: "call/1",
    isError: true,
    result: { content: "secret output" },
  });
  const events = socket.frames.filter((event) => event.type === "activity");
  assert.deepEqual(events.slice(1), [
    {
      type: "activity",
      id: config.id,
      event: "tool_execution_start",
      toolName: "bash",
      toolCallId: "call/1",
      parentToolCallId: "call",
    },
    {
      type: "activity",
      id: config.id,
      event: "tool_execution_end",
      toolName: "bash",
      toolCallId: "call/1",
      isError: true,
    },
  ]);
});

test("cancel clears startup controls and does not resubmit canceled native queue", () => {
  const h = harness();
  const socket = h.start();
  socket.command({ type: "task", prompt: "work" });
  socket.command({ type: "task", prompt: "queued" });
  socket.command({ type: "cancel" });
  socket.command({ type: "task", prompt: "must wait" });
  assert.equal(h.aborts, 1);
  assert.equal(h.editor, "local unfinished draft");
  h.emit("agent_start");
  assert.equal(h.messages.length, 1);
  h.emit("agent_end");
  assert.equal(completions(socket).length, 0);
  h.emit("agent_settled");
  assert.equal(completions(socket)[0]?.canceled, true);
  socket.command({ type: "task", prompt: "new task" });
  assert.equal(h.messages.at(-1)?.text, "new task");
});

test("cancel before input interception prevents startup and completes once", () => {
  const h = harness();
  const socket = h.start();
  socket.command({ type: "task", prompt: "work" });
  socket.command({ type: "cancel" });
  assert.deepEqual(h.emit("input", { source: "extension", text: "work" }), {
    action: "handled",
  });
  assert.equal(completions(socket).length, 1);
  assert.equal(completions(socket)[0]?.canceled, true);
  h.emit("agent_settled");
  assert.equal(completions(socket).length, 1);
});

test("idle steer/cancel do not create work; pending commands are bounded", () => {
  const h = harness();
  const socket = h.start();
  socket.command({ type: "steer", message: "no task" });
  socket.command({ type: "cancel" });
  assert.equal(h.messages.length, 0);
  assert.equal(h.aborts, 0);
  for (let n = 0; n <= MAX_PENDING_COMMANDS; n++) {
    socket.command({ type: "task", prompt: `task ${n}` });
  }
  h.emit("agent_start");
  assert.equal(h.messages.length, MAX_PENDING_COMMANDS);
  assert.ok(
    socket.frames.some(
      (event) =>
        event.type === "activity" && event.event === "control_rejected",
    ),
  );
});

test("final errors, aborts, all text blocks and byte-safe truncation", () => {
  for (const reason of ["error", "aborted", "stop"]) {
    const h = harness();
    const socket = h.start();
    socket.command({ type: "task", prompt: "work" });
    h.emit("agent_start");
    h.emit("message_end", {
      message: assistant("中文🙂".repeat(MAX_RESULT_BYTES), reason, "failure"),
    });
    h.emit("agent_settled");
    const final = completions(socket)[0];
    assert.ok(final);
    assert.ok(Buffer.byteLength(final.result) <= MAX_RESULT_BYTES);
    assert.equal(final.result.includes("\ufffd"), false);
    assert.equal(final.truncated, true);
    assert.equal(final.error, reason === "error" ? "failure" : undefined);
    assert.equal(final.canceled, reason === "aborted" ? true : undefined);
  }
});

test("missing model or credentials completes rather than waiting for Pi events", async () => {
  const missing = harness();
  const noModelSocket = missing.start();
  missing.ctx.model = undefined;
  noModelSocket.command({ type: "task", prompt: "work" });
  assert.match(completions(noModelSocket)[0]?.error ?? "", /No Pi model/);
  assert.equal(missing.messages.length, 0);

  const h = harness();
  const socket = h.start();
  h.ctx.modelRegistry.hasConfiguredAuth = () => false;
  h.ctx.modelRegistry.getApiKeyAndHeaders = async () => ({
    ok: false,
    error: "No credentials",
  });
  socket.command({ type: "task", prompt: "work" });
  await setImmediate();
  assert.match(completions(socket)[0]?.error ?? "", /No credentials/);
  assert.equal(h.messages.length, 0);
});

test("cancel or shutdown during auth preflight cannot submit stale work", async () => {
  for (const action of ["cancel", "shutdown"]) {
    const h = harness();
    const socket = h.start();
    let resolve: (() => void) | undefined;
    h.ctx.modelRegistry.hasConfiguredAuth = () => false;
    h.ctx.modelRegistry.getApiKeyAndHeaders = () =>
      new Promise((done) => {
        resolve = () => done({ ok: true });
      });
    socket.command({ type: "task", prompt: "work" });
    if (action === "cancel") socket.command({ type: "cancel" });
    else h.emit("session_shutdown");
    assert.ok(resolve);
    resolve();
    await setImmediate();
    assert.equal(h.messages.length, 0);
    if (action === "cancel") {
      assert.equal(completions(socket)[0]?.canceled, true);
    }
  }
});

test("synchronous Pi submission failures produce completed errors", () => {
  const h = harness();
  const socket = h.start();
  h.pi.sendUserMessage = () => {
    throw new Error("submission failed");
  };
  socket.command({ type: "task", prompt: "work" });
  assert.match(completions(socket)[0]?.error ?? "", /submission failed/);
});

test("disconnect, malformed input and backpressure abort and terminate the worker once", () => {
  for (const failure of ["close", "error", "oversize", "invalid", "slow"]) {
    const h = harness();
    const socket = h.start();
    socket.command({ type: "task", prompt: "work" });
    h.emit("agent_start");
    if (failure === "close") socket.destroy();
    if (failure === "error") socket.emit("error", new Error("offline"));
    if (failure === "oversize") {
      socket.emit("data", Buffer.alloc(MAX_COMMAND_BYTES + 1, 65));
    }
    if (failure === "invalid") socket.emit("data", Buffer.from("garbage\n"));
    if (failure === "slow") {
      socket.writableLength = 1024 * 1024;
      h.emit("agent_end");
    }
    assert.equal(socket.destroyed, true);
    const count = socket.frames.length;
    socket.command({ type: "cancel" });
    h.emit("message_end", { message: assistant("still works") });
    h.emit("agent_settled");
    assert.equal(socket.frames.length, count);
    assert.equal(h.aborts, 1);
    assert.equal(h.shutdowns, 1);
    assert.equal(h.terminations, 1);
    h.emit("session_start");
    assert.equal(h.connects, 1, "must not reconnect or replay tasks");
  }
});

test("failure to establish the parent connection terminates the worker", () => {
  const h = harness();
  h.emit("session_start");
  const socket = h.sockets[0];
  socket.emit("error", new Error("Connection refused"));
  assert.equal(socket.destroyed, true);
  assert.equal(h.aborts, 1);
  assert.equal(h.shutdowns, 1);
  assert.equal(h.terminations, 1);
});

test("worker's own shutdown closes IPC without recursively requesting termination", () => {
  const h = harness();
  const socket = h.start();
  h.emit("session_shutdown");
  assert.equal(socket.destroyed, true);
  assert.equal(h.shutdowns, 0);
  assert.equal(h.terminations, 0);
});

test("idle and native workers also terminate on parent loss", () => {
  for (const native of [false, true]) {
    const h = harness();
    const socket = h.start();
    if (native) h.emit("before_agent_start");
    socket.destroy();
    socket.emit("error", new Error("Parent gone"));
    assert.equal(h.aborts, 1);
    assert.equal(h.shutdowns, 1);
    assert.equal(h.terminations, 1);
  }
});

test("parent loss during auth preflight invalidates the pending prompt", async () => {
  const h = harness();
  const socket = h.start();
  let resolve: (() => void) | undefined;
  h.ctx.modelRegistry.hasConfiguredAuth = () => false;
  h.ctx.modelRegistry.getApiKeyAndHeaders = () =>
    new Promise((done) => {
      resolve = () => done({ ok: true });
    });
  socket.command({ type: "task", prompt: "work" });
  socket.destroy();
  assert.ok(resolve);
  resolve();
  await setImmediate();
  assert.equal(h.messages.length, 0);
  assert.equal(h.terminations, 1);
});

test("session replacement closes the old connection and reports the fresh path", () => {
  const h = harness();
  const old = h.start();
  const replacement = h.start();
  assert.equal(old.destroyed, true);
  old.command({ type: "task", prompt: "stale" });
  replacement.command({ type: "task", prompt: "fresh" });
  assert.equal(h.messages.length, 1);
  assert.equal(h.messages[0]?.text, "fresh");
  assert.equal(h.shutdowns, 0);
  assert.equal(h.terminations, 0);
});

test("real loopback TCP uses JSONL without taking over Pi stdio", async (t) => {
  const server = createServer();
  t.after(() => server.close());
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const accepted = once(server, "connection");
  const h = harness(() =>
    // The factory uses node:net by default; the test only overrides the port.
    createTestConnection(address.port),
  );
  h.emit("session_start");
  const [connection] = (await accepted) as [Socket];
  t.after(() => {
    h.emit("session_shutdown");
    connection.destroy();
  });
  connection.setEncoding("utf8");
  const ready = await new Promise<unknown>((resolve) => {
    let buffer = "";
    const receive = (chunk: string) => {
      buffer += chunk;
      const end = buffer.indexOf("\n");
      if (end < 0) return;
      connection.off("data", receive);
      resolve(JSON.parse(buffer.slice(0, end)));
    };
    connection.on("data", receive);
  });
  assert.deepEqual(ready, {
    type: "ready",
    id: config.id,
    token: config.token,
    sessionPath: "/sessions/worker.jsonl",
    model: "test/test-model",
    modelName: "Test Model",
  });
  const delivered = once(h.sent, "message");
  connection.write('{"type":"task","prompt":"TCP task"}\n');
  await delivered;
  assert.equal(h.messages[0]?.text, "TCP task");
  connection.destroy();
  await setImmediate();
  assert.equal(h.aborts, 0);
});

function createTestConnection(port: number): Socket {
  return createConnection({ host: "127.0.0.1", port });
}
