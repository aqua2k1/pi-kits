import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { access, readFile, rm, stat } from "node:fs/promises";
import { PassThrough } from "node:stream";
import test from "node:test";
import type { AgentDefinition } from "../agents.ts";
import {
  type MuxAdapter,
  type StartOptions,
  type TerminalHandle,
  TerminalStartError,
} from "../mux.ts";
import type { RuntimeEvent, RuntimeOptions } from "../runtime.ts";
import { RuntimeTaskRejectedError } from "../runtime-errors.ts";
import { type CodexDependencies, CodexRuntime } from "./codex.ts";
import type { CodexRpc } from "./codex-transport.ts";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function must<T>(value: T | undefined): T {
  assert.notEqual(value, undefined);
  return value as T;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const agent = (extra: Partial<AgentDefinition> = {}): AgentDefinition => ({
  name: "test",
  description: "test",
  systemPrompt: "developer rules",
  enabled: true,
  source: "project",
  sourcePath: "/fake/test.md",
  ...extra,
});
function fixture(
  extra: Partial<RuntimeOptions> = {},
  overrides: Partial<CodexDependencies> = {},
) {
  const events: RuntimeEvent[] = [];
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const handlers = new Map<
    string,
    (params: Record<string, unknown>) => unknown
  >();
  const children: Array<
    EventEmitter & {
      killed: boolean;
      exitCode: number | null;
      signalCode: string | null;
    }
  > = [];
  let notification!: (method: string, params: Record<string, unknown>) => void;
  let disconnected!: (error: Error) => void;
  let argv: string[] = [];
  let authToken = "";
  let closes = 0;
  let connectTimeoutMs = 0;
  let requestTimeoutMs = 0;
  let rejectServerRequest: () => boolean | Promise<boolean> = () => true;
  let alive = true;
  const starts: StartOptions[] = [];
  const destroyed: TerminalHandle[] = [];
  const mux: MuxAdapter = {
    check_env: () => true,
    async start(options) {
      starts.push(options);
      return { id: `native-${starts.length}` };
    },
    async inspect() {
      return { alive };
    },
    async destroy(terminal) {
      destroyed.push(terminal);
    },
    async open_view() {
      return { id: "view" };
    },
    async inspect_view() {
      return { alive: true };
    },
    async focus_view() {},
    async close_view() {},
  };
  async function respond(method: string, value: unknown): Promise<unknown> {
    const params = value as Record<string, unknown>;
    calls.push({ method, params });
    if (handlers.has(method)) return must(handlers.get(method))(params);
    switch (method) {
      case "initialize":
        return { userAgent: "codex/0.160.0" };
      case "model/list":
        return {
          data: [
            {
              model: "agent-model",
              isDefault: true,
              supportedReasoningEfforts: [
                { reasoningEffort: "high" },
                { reasoningEffort: "none" },
              ],
            },
          ],
        };
      case "thread/start":
        return {
          thread: {
            id: "thread",
            sessionId: "session",
            path: "/history/thread.jsonl",
          },
          model: "agent-model",
          modelProvider: "openai",
          reasoningEffort: "high",
        };
      case "thread/read":
        return {
          thread: {
            id: "thread",
            status: { type: "idle" },
            model: "native-model",
            reasoningEffort: "low",
            modelProvider: "openai",
          },
        };
      case "turn/start":
        return {
          turn: {
            id: `turn-${calls.filter((call) => call.method === "turn/start").length}`,
          },
        };
      case "thread/items/list":
        return { data: [], nextCursor: null };
      default:
        return {};
    }
  }
  const rpc: CodexRpc = {
    async request<T>(method: string, params: unknown): Promise<T> {
      return (await respond(method, params)) as T;
    },
    notify(method, params) {
      calls.push({ method, params: params as Record<string, unknown> });
    },
    close() {
      closes++;
    },
  };
  const dependencies: CodexDependencies = {
    async removeDirectory(path) {
      await rm(path, { recursive: true, force: true });
    },
    async probe() {
      return "codex-cli 0.160.0";
    },
    async address() {
      return "ws://127.0.0.1:12345";
    },
    spawn(_executable, args) {
      argv = args;
      const emitter = new EventEmitter();
      const child = Object.assign(emitter, {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        killed: false,
        exitCode: null as number | null,
        signalCode: null as string | null,
        kill(signal: string) {
          this.killed = true;
          this.signalCode = signal;
          queueMicrotask(() => emitter.emit("exit", null, signal));
          return true;
        },
      });
      children.push(child);
      return child as unknown as ChildProcess;
    },
    async connect(
      _url,
      token,
      onNotification,
      onDisconnected,
      connectTimeout,
      requestTimeout,
      shouldRejectServerRequest,
    ) {
      connectTimeoutMs = connectTimeout;
      requestTimeoutMs = requestTimeout;
      rejectServerRequest = shouldRejectServerRequest;
      authToken = token;
      notification = onNotification;
      disconnected = onDisconnected;
      return rpc;
    },
    ...overrides,
  };
  const runtime = new CodexRuntime(dependencies);
  const session = runtime.create(
    { id: "test", cwd: "/tmp", ...extra },
    { mux, emit: (event) => events.push(event) },
  );
  return {
    runtime,
    session,
    mux,
    events,
    calls,
    handlers,
    children,
    destroyed,
    get argv() {
      return argv;
    },
    get token() {
      return authToken;
    },
    get timeouts() {
      return { connectTimeoutMs, requestTimeoutMs };
    },
    shouldRejectServerRequest() {
      return rejectServerRequest();
    },
    get closes() {
      return closes;
    },
    get starts() {
      return starts;
    },
    setAlive(value: boolean) {
      alive = value;
    },
    event(method: string, params: Record<string, unknown>) {
      notification(method, { threadId: "thread", ...params });
    },
    disconnect() {
      disconnected(new Error("lost connection"));
    },
  };
}
function finished(
  f: ReturnType<typeof fixture>,
  id = "turn-1",
  extra: Record<string, unknown> = {},
) {
  f.event("turn/completed", {
    turn: { id, status: "completed", itemsView: "full", items: [], ...extra },
  });
}

test("validate rejects cross-runtime clones and invalid supported thinking", () => {
  const runtime = new CodexRuntime();
  const base = { id: "test", cwd: "/tmp" };
  for (const extra of [
    { parentSession: {} },
    { agent: agent({ inheritContext: true }) },
    { thinking: "ultra" },
  ])
    assert.throws(() =>
      runtime.validate({ ...base, ...extra } as RuntimeOptions),
    );
  runtime.validate({
    ...base,
    thinking: "off",
    agent: agent({ inheritContext: false }),
  });
});

test("Codex validates explicit prompt modes while allowing omission", () => {
  const runtime = new CodexRuntime();
  const base = { id: "test", cwd: "/tmp" };
  for (const promptMode of ["replace", "append"] as const) {
    assert.throws(
      () => runtime.validate({ ...base, agent: agent({ promptMode }) }),
      /prompt_mode.*Pi runtime/,
    );
  }
  runtime.validate({ ...base, agent: agent() });
});

test("unsupported options are ignored without changing Codex policy or task tools", async (t) => {
  const rawAgent = {
    ...agent({ tools: [], disallowedTools: ["edit"] }),
    codex: { sandbox: "danger-full-access", approvalPolicy: "always" },
  };
  const f = fixture({
    agent: rawAgent,
    extensionAllowlist: ["ignored-extension"],
    workerPath: "ignored-worker.ts",
  });
  t.after(() => f.session.close());
  await f.session.start();
  const params = must(
    f.calls.find((call) => call.method === "thread/start"),
  ).params;
  assert.equal(params.sandbox, "workspace-write");
  assert.equal(params.approvalPolicy, "never");
  await f.session.send({
    type: "task",
    prompt: "Task",
    round: 1,
    instructions: { systemPrompt: "developer rules", tools: [] },
  });
  const submitted = must(
    f.calls.find((call) => call.method === "turn/start"),
  ).params;
  assert.equal(submitted.tools, undefined);
  finished(f);
  await tick();
  assert.ok(f.events.some((event) => event.type === "completed"));
});

test("start owns private token file, probes protocol, maps developer instructions and safe defaults", async (t) => {
  const f = fixture({
    model: "fallback",
    thinking: "low",
    agent: agent({ model: "agent-model", thinking: "high" }),
  });
  t.after(() => f.session.close());
  await f.session.start();
  await f.session.start();
  assert.equal(f.children.length, 1);
  const tokenFile = must(f.argv.at(-1));
  assert.equal((await stat(tokenFile)).mode & 0o777, 0o600);
  assert.equal(await readFile(tokenFile, "utf8"), f.token);
  assert.equal(f.argv.includes("--ws-auth"), true);
  assert.equal(f.argv.includes("capability-token"), true);
  assert.equal(f.starts.length, 0);
  const params = must(
    f.calls.find((call) => call.method === "thread/start"),
  ).params;
  assert.equal(params.model, "agent-model");
  assert.equal(
    (params.config as Record<string, unknown>).model_reasoning_effort,
    "high",
  );
  assert.equal(params.developerInstructions, "developer rules");
  assert.equal(params.sandbox, "workspace-write");
  assert.equal(params.approvalPolicy, "never");
  assert.equal(
    (
      must(f.calls.find((call) => call.method === "initialize")).params
        .capabilities as Record<string, unknown>
    ).experimentalApi,
    false,
  );
  assert.equal(
    must(f.events.find((event) => event.type === "session_state")).sessionPath,
    "/history/thread.jsonl",
  );
  await f.session.close();
  assert.equal(f.children[0].killed, true);
  await assert.rejects(access(tokenFile));
});

test("close retains the token directory when deletion fails and retries it", async (t) => {
  let canRemove = false;
  const removed: string[] = [];
  const f = fixture(
    {},
    {
      async removeDirectory(path) {
        removed.push(path);
        if (!canRemove) throw new Error("Directory cleanup unavailable");
        await rm(path, { recursive: true, force: true });
      },
    },
  );
  t.after(async () => {
    canRemove = true;
    await f.session.close();
  });
  await f.session.start();
  const tokenFile = must(f.argv.at(-1));
  const closing = f.session.close();
  assert.equal(f.session.close(), closing);
  await assert.rejects(closing, /Directory cleanup unavailable/);
  await access(tokenFile);
  assert.equal(f.children[0].killed, true);
  assert.equal(f.closes, 1);
  canRemove = true;
  await f.session.close();
  assert.equal(removed.length, 2);
  assert.equal(removed[0], removed[1]);
  await assert.rejects(access(tokenFile));
  assert.equal(f.closes, 1);
});

test("sessions have distinct backend children and authentication tokens", async (t) => {
  const a = fixture();
  const b = fixture();
  t.after(() => Promise.all([a.session.close(), b.session.close()]));
  await Promise.all([a.session.start(), b.session.start()]);
  assert.notEqual(a.token, b.token);
  assert.notEqual(a.argv.at(-1), b.argv.at(-1));
  assert.notEqual(a.children[0], b.children[0]);
});

test("startup failures kill child and delete token; version mismatch fails before spawn", async () => {
  const f = fixture();
  f.handlers.set("initialize", () => {
    throw new Error("bad handshake");
  });
  await assert.rejects(f.session.start(), /bad handshake/);
  assert.equal(f.session.connected, false);
  assert.equal(f.children[0].killed, true);
  await assert.rejects(access(must(f.argv.at(-1))));
  assert.equal(
    f.events.some((event) => event.type === "disconnected"),
    true,
  );
  await f.session.close();
  const old = fixture(
    {},
    {
      async probe() {
        return "codex-cli 0.159.0";
      },
    },
  );
  await assert.rejects(old.session.start(), /0.160.0/);
  assert.equal(old.children.length, 0);
  await old.session.close();
});

test("startup RPC deadline cleans resources", async () => {
  const f = fixture({ startupTimeoutMs: 80 });
  f.handlers.set("initialize", () => new Promise(() => {}));
  await assert.rejects(f.session.start(), /timeout/i);
  assert.equal(f.children[0].killed, true);
  await assert.rejects(access(must(f.argv.at(-1))));
  await f.session.close();
});

test("unsupported model effort fails startup, off maps to none", async (t) => {
  const invalid = fixture({ thinking: "xhigh" });
  await assert.rejects(invalid.session.start(), /does not support/);
  await invalid.session.close();
  const f = fixture({ thinking: "off" });
  t.after(() => f.session.close());
  await f.session.start();
  assert.equal(
    (
      must(f.calls.find((call) => call.method === "thread/start")).params
        .config as Record<string, unknown>
    ).model_reasoning_effort,
    "none",
  );
});

test("early notifications are assigned only to returned turnId and round; native turns ignored", async (t) => {
  const f = fixture();
  t.after(() => f.session.close());
  await f.session.start();
  f.handlers.set("turn/start", () => {
    finished(f, "native", {
      items: [
        {
          type: "agentMessage",
          id: "native-answer",
          text: "wrong",
          phase: "final_answer",
        },
      ],
    });
    f.event("item/completed", {
      turnId: "managed",
      item: {
        type: "agentMessage",
        id: "answer",
        text: "right",
        phase: "final_answer",
      },
    });
    finished(f, "managed");
    return { turn: { id: "managed" } };
  });
  await f.session.send({ type: "task", prompt: "go", round: 4 });
  await tick();
  const completed = f.events.filter((event) => event.type === "completed");
  assert.equal(completed.length, 1);
  assert.equal(completed[0].result, "right");
  assert.equal(completed[0].round, 4);
  assert.equal(completed[0].turnId, "managed");
  assert.equal(
    must(f.events.find((event) => event.type === "started")).round,
    4,
  );
  finished(f, "native-again");
  assert.equal(
    f.events.filter((event) => event.type === "completed").length,
    1,
  );
});

test("cancel during turn/start is deferred, steer uses strict id, interrupted event confirms canceled", async (t) => {
  const f = fixture();
  t.after(() => f.session.close());
  await f.session.start();
  const response = deferred<unknown>();
  f.handlers.set("turn/start", () => response.promise);
  const sending = f.session.send({ type: "task", prompt: "go", round: 1 });
  await tick();
  await f.session.send({ type: "cancel", round: 1 });
  assert.equal(
    f.calls.some((call) => call.method === "turn/interrupt"),
    false,
  );
  response.resolve({ turn: { id: "known" } });
  await sending;
  assert.deepEqual(
    must(f.calls.find((call) => call.method === "turn/interrupt")).params,
    { threadId: "thread", turnId: "known" },
  );
  assert.equal(
    f.events.some((event) => event.type === "completed"),
    false,
  );
  await f.session.send({ type: "steer", message: "adjust", round: 1 });
  assert.equal(
    must(f.calls.find((call) => call.method === "turn/steer")).params
      .expectedTurnId,
    "known",
  );
  assert.equal(
    f.calls.filter((call) => call.method === "turn/start").length,
    1,
  );
  await assert.rejects(async () => {
    await f.session.send({ type: "steer", message: "wrong", round: 2 });
  }, /matching/);
  finished(f, "known", { status: "interrupted" });
  await tick();
  assert.equal(
    must(f.events.find((event) => event.type === "completed")).canceled,
    true,
  );
  await f.session.send({ type: "cancel" });
  assert.equal(
    f.calls.filter((call) => call.method === "turn/interrupt").length,
    1,
  );
});

test("cancel request does not label a normally completed turn canceled", async (t) => {
  const f = fixture();
  t.after(() => f.session.close());
  await f.session.start();
  await f.session.send({ type: "task", prompt: "go" });
  await f.session.send({ type: "cancel" });
  finished(f);
  await tick();
  assert.equal(
    must(f.events.find((event) => event.type === "completed")).canceled,
    false,
  );
});

test("paged notLoaded items hydrate final answer, bound UTF-8 result, count unique tools and usage", async (t) => {
  const f = fixture();
  t.after(() => f.session.close());
  await f.session.start();
  await f.session.send({ type: "task", prompt: "go", round: 1 });
  const item = { type: "commandExecution", id: "tool", command: "ls" };
  f.event("item/started", { turnId: "turn-1", item });
  f.event("item/completed", { turnId: "turn-1", item });
  const usage = {
    last: {
      totalTokens: 31,
      inputTokens: 20,
      cachedInputTokens: 3,
      outputTokens: 11,
      reasoningOutputTokens: 2,
    },
    total: {
      totalTokens: 31,
      inputTokens: 20,
      cachedInputTokens: 3,
      outputTokens: 11,
      reasoningOutputTokens: 2,
    },
  };
  f.event("thread/tokenUsage/updated", {
    turnId: "native",
    tokenUsage: { last: { totalTokens: 500 } },
  });
  f.event("thread/tokenUsage/updated", { turnId: "turn-1", tokenUsage: usage });
  f.handlers.set("thread/items/list", (params) =>
    params.cursor
      ? {
          data: [
            {
              item: {
                type: "agentMessage",
                id: "answer",
                phase: "final_answer",
                text: "界".repeat(30_000),
              },
            },
          ],
          nextCursor: null,
        }
      : { data: [{ item }], nextCursor: "next" },
  );
  finished(f, "turn-1", { itemsView: "notLoaded" });
  await tick();
  const result = must(f.events.find((event) => event.type === "completed"));
  assert.equal(result.truncated, true);
  assert.ok(Buffer.byteLength(result.result as string) <= 65536);
  assert.equal((result.result as string).includes("�"), false);
  const stats = must(f.events.filter((event) => event.type === "stats").at(-1));
  assert.equal(stats.turnCount, 1);
  assert.equal(stats.toolUses, 1);
  assert.equal(stats.totalTokens, 28);
  assert.deepEqual(stats.usage, { ...usage, delta: usage.total });
  assert.equal(
    f.calls.filter((call) => call.method === "thread/items/list").length,
    2,
  );
});

test("resume uses same thread without overriding native model or effort", async (t) => {
  const f = fixture({ agent: agent({ thinking: "high" }) });
  t.after(() => f.session.close());
  await f.session.start();
  await f.session.send({ type: "task", prompt: "first", round: 1 });
  finished(f);
  await tick();
  await f.session.send({ type: "task", prompt: "resume", round: 2 });
  finished(f, "turn-2");
  await tick();
  assert.equal(
    f.calls.filter((call) => call.method === "thread/start").length,
    1,
  );
  for (const call of f.calls.filter((call) => call.method === "turn/start")) {
    assert.equal(call.params.threadId, "thread");
    assert.equal("model" in call.params, false);
    assert.equal("effort" in call.params, false);
  }
  assert.equal(
    must(f.events.filter((event) => event.type === "stats").at(-1)).turnCount,
    1,
  );
});

test("native attachment retains backend on detach, blocks managed sends until terminal exits", async (t) => {
  const f = fixture();
  t.after(() => f.session.close());
  await f.session.start();
  const terminal = await f.session.attachment();
  assert.equal(f.session.terminal, terminal);
  assert.equal(await f.session.attachment(), terminal);
  assert.equal(f.starts[0].env.PI_KITS_SUBAGENT_WORKER, "1");
  assert.deepEqual(f.starts[0].argv.slice(-2), ["resume", "thread"]);
  assert.equal(f.starts[0].argv.includes(f.token), false);
  await f.mux.close_view({ id: "view" });
  await assert.rejects(async () => {
    await f.session.send({ type: "task", prompt: "blocked" });
  }, /Exit the native/);
  await f.session.send({ type: "cancel" });
  assert.equal(
    f.calls.some((call) => call.method === "turn/interrupt"),
    false,
  );
  assert.equal(f.closes, 0);
  f.setAlive(false);
  await f.session.send({ type: "task", prompt: "allowed" });
  assert.deepEqual(f.destroyed, [terminal]);
  f.setAlive(true);
  const next = await f.session.attachment();
  assert.equal(f.session.capabilities.concurrentNativeInput, true);
  finished(f);
  await tick();
  assert.equal(await f.session.attachment(), next);
  assert.notEqual(next.id, terminal.id);
});

test("running native attachment keeps managed steer/cancel and result ownership", async (t) => {
  const f = fixture();
  t.after(() => f.session.close());
  await f.session.start();
  await f.session.send({ type: "task", prompt: "go", round: 1 });
  const terminal = await f.session.attachment();
  assert.equal(await f.session.attachment(), terminal);
  assert.equal(await f.shouldRejectServerRequest(), false);
  await f.session.send({
    type: "steer",
    message: "native and managed input",
    round: 1,
  });
  await f.session.send({ type: "cancel", round: 1 });
  assert.deepEqual(
    f.calls
      .filter((call) => ["turn/steer", "turn/interrupt"].includes(call.method))
      .map((call) => [
        call.method,
        call.params.expectedTurnId ?? call.params.turnId,
      ]),
    [
      ["turn/steer", "turn-1"],
      ["turn/interrupt", "turn-1"],
    ],
  );
  finished(f, "turn-1", { status: "interrupted" });
  await tick();
  const completed = must(f.events.find((event) => event.type === "completed"));
  assert.equal(completed.canceled, true);
  finished(f, "native-followup");
  await tick();
  assert.equal(
    f.events.filter((event) => event.type === "completed").length,
    1,
  );
  assert.equal(f.session.terminal, terminal);
});

test("attachment waits for turn/start acknowledgment and shares concurrent requests", async (t) => {
  const f = fixture();
  t.after(() => f.session.close());
  await f.session.start();
  const response = deferred<unknown>();
  f.handlers.set("turn/start", () => response.promise);
  const sending = f.session.send({ type: "task", prompt: "go" });
  await tick();
  const attaching = f.session.attachment();
  assert.equal(f.session.attachment(), attaching);
  await tick();
  assert.equal(f.starts.length, 0);
  response.resolve({ turn: { id: "turn-1" } });
  await sending;
  await attaching;
  assert.equal(f.starts.length, 1);
  f.setAlive(false);
  assert.equal(await f.shouldRejectServerRequest(), true);
});

test("native turn started during result hydration remains interactive", async (t) => {
  const f = fixture();
  t.after(() => f.session.close());
  await f.session.start();
  await f.session.send({ type: "task", prompt: "go" });
  await f.session.attachment();
  const items = deferred<unknown>();
  f.handlers.set("thread/items/list", () => items.promise);
  finished(f, "turn-1", { itemsView: "notLoaded", items: [] });
  f.event("turn/started", {
    turn: { id: "native-turn", status: "inProgress" },
  });
  items.resolve({ data: [], nextCursor: null });
  await tick();
  assert.equal(
    must(f.events.filter((event) => event.type === "session_state").at(-1))
      .state,
    "interactive",
  );
  assert.equal(
    f.events.filter((event) => event.type === "completed").length,
    1,
  );
});

test("failed native destroy retains opaque handle and forbids submit", async (t) => {
  const f = fixture();
  t.after(() => f.session.close());
  await f.session.start();
  const terminal = await f.session.attachment();
  f.setAlive(false);
  const destroy = f.mux.destroy;
  f.mux.destroy = async () => {
    throw new Error("ownership cleanup failed");
  };
  await assert.rejects(async () => {
    await f.session.send({ type: "task", prompt: "go" });
  }, /cleanup failed/);
  assert.equal(f.session.terminal, terminal);
  assert.equal(
    f.calls.some((call) => call.method === "turn/start"),
    false,
  );
  f.mux.destroy = destroy;
});

test("attachment reservation and final terminal inspector prevent managed send race", async (t) => {
  const f = fixture();
  t.after(() => f.session.close());
  await f.session.start();
  const terminal = await f.session.attachment();
  let inspections = 0;
  f.mux.inspect = async () => ({ alive: ++inspections > 1 });
  // Exit first terminal; make a new live terminal observable at the final inspector.
  f.mux.destroy = async () => {
    f.destroyed.push(terminal);
  };
  const read = f.handlers;
  let waitingAttachment: Promise<TerminalHandle> | undefined;
  read.set("thread/read", async () => {
    waitingAttachment = f.session.attachment();
    assert.equal(
      f.starts.length,
      1,
      "Do not attach during submission preflight",
    );
    return { thread: { status: { type: "idle" } } };
  });
  await f.session.send({ type: "task", prompt: "go" });
  // Handle has been destroyed, so no following/moved handle is inspected.
  assert.equal(inspections, 1);
  await must(waitingAttachment);
  finished(f);
  await tick();
  f.mux.inspect = async () => ({ alive: false });
  const pending = deferred<TerminalHandle>();
  f.mux.start = async () => pending.promise;
  const attaching = f.session.attachment();
  await tick();
  await assert.rejects(async () => {
    await f.session.send({ type: "task", prompt: "race" });
  }, /in progress/);
  pending.resolve({ id: "replacement" });
  await attaching;
});

test("native ongoing turn remains protected even after TUI exit; child exit/disconnect is surfaced", async (t) => {
  const f = fixture();
  t.after(() => f.session.close());
  await f.session.start();
  f.handlers.set("thread/read", () => ({
    thread: { status: { type: "active" } },
  }));
  await assert.rejects(async () => {
    await f.session.send({ type: "task", prompt: "go" });
  }, /not idle/);
  assert.equal(
    f.calls.some((call) => call.method === "turn/start"),
    false,
  );
  f.children[0].emit("exit", 2, null);
  await tick();
  assert.equal(f.session.connected, false);
  assert.equal(
    f.events.filter((event) => event.type === "disconnected").length,
    1,
  );
  await assert.rejects(async () => {
    await f.session.send({ type: "cancel" });
  }, /disconnected/);
});

test("RPC errors propagate without starting extra turns; blocked requests are reported", async (t) => {
  const f = fixture();
  t.after(() => f.session.close());
  await f.session.start();
  await f.session.send({ type: "task", prompt: "go" });
  f.handlers.set("turn/steer", () => {
    throw new Error("expectedTurnId mismatch");
  });
  await assert.rejects(async () => {
    await f.session.send({ type: "steer", message: "go" });
  }, /mismatch/);
  f.event("runtime/blocked", {
    turnId: "turn-1",
    requestMethod: "item/tool/requestUserInput",
  });
  assert.equal(
    must(f.events.find((event) => event.type === "blocked")).round,
    1,
  );
  finished(f, "turn-1", {
    status: "failed",
    error: { message: "input unavailable" },
  });
  await tick();
  assert.equal(
    must(f.events.find((event) => event.type === "completed")).error,
    "input unavailable",
  );
  assert.equal(
    f.calls.filter((call) => call.method === "turn/start").length,
    1,
  );
});

test("round counters use total-usage delta, reset on resume, and exclude native usage", async (t) => {
  const f = fixture();
  t.after(() => f.session.close());
  await f.session.start();
  const usage = (
    inputTokens: number,
    cachedInputTokens: number,
    outputTokens: number,
  ) => ({
    total: {
      inputTokens,
      cachedInputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      reasoningOutputTokens: 3,
    },
    last: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  });
  await f.session.send({ type: "task", prompt: "first", round: 1 });
  f.event("item/completed", {
    turnId: "turn-1",
    item: { type: "commandExecution", id: "first-tool" },
  });
  f.event("thread/tokenUsage/updated", {
    turnId: "turn-1",
    tokenUsage: usage(100, 20, 10),
  });
  finished(f);
  await tick();
  const first = must(f.events.filter((event) => event.type === "stats").at(-1));
  assert.equal(first.totalTokens, 90);
  assert.equal(first.toolUses, 1);
  assert.equal(first.turnCount, 1);
  const count = f.events.filter((event) => event.type === "stats").length;
  f.event("thread/tokenUsage/updated", {
    turnId: "native",
    tokenUsage: usage(200, 40, 20),
  });
  assert.equal(
    f.events.filter((event) => event.type === "stats").length,
    count,
  );
  await f.session.send({ type: "task", prompt: "resume", round: 2 });
  const reset = must(f.events.filter((event) => event.type === "stats").at(-1));
  assert.equal(reset.totalTokens, 0);
  assert.equal(reset.toolUses, 0);
  assert.equal(reset.turnCount, 0);
  f.event("thread/tokenUsage/updated", {
    turnId: "turn-2",
    tokenUsage: usage(250, 50, 25),
  });
  finished(f, "turn-2");
  await tick();
  const second = must(
    f.events.filter((event) => event.type === "stats").at(-1),
  );
  assert.equal(second.totalTokens, 45);
  assert.equal(second.toolUses, 0);
  assert.equal(second.turnCount, 1);
  const details = second.usage as { delta: Record<string, number> };
  assert.equal(details.delta.inputTokens, 50);
  assert.equal(details.delta.cachedInputTokens, 10);
});

test("pre-dispatch rejection is typed, emits no disconnect, and can be retried; post-send errors are not typed", async (t) => {
  const f = fixture();
  t.after(() => f.session.close());
  await f.session.start();
  await f.session.attachment();
  await assert.rejects(async () => {
    await f.session.send({ type: "task", prompt: "blocked", round: 1 });
  }, RuntimeTaskRejectedError);
  assert.equal(
    f.events.some((event) => event.type === "disconnected"),
    false,
  );
  assert.equal(f.session.connected, true);
  f.setAlive(false);
  f.handlers.set("turn/start", () => {
    throw new Error("ambiguous network failure");
  });
  await assert.rejects(
    async () => {
      await f.session.send({ type: "task", prompt: "retry", round: 1 });
    },
    (error: unknown) =>
      error instanceof Error && !(error instanceof RuntimeTaskRejectedError),
  );
});

test("runtime separates short connection attempts from 60-second requests", async (t) => {
  const f = fixture();
  t.after(() => f.session.close());
  await f.session.start();
  assert.ok(
    f.timeouts.connectTimeoutMs > 0 && f.timeouts.connectTimeoutMs <= 1000,
  );
  assert.equal(f.timeouts.requestTimeoutMs, 60_000);
});

test("disconnect preserves idle backend and live native terminal until explicit close", async (t) => {
  const f = fixture();
  t.after(() => f.session.close());
  await f.session.start();
  await f.session.send({ type: "task", prompt: "first", round: 1 });
  finished(f);
  await tick();
  const terminal = await f.session.attachment();
  const tokenFile = must(f.argv.at(-1));
  f.disconnect();
  f.disconnect();
  await tick();
  assert.equal(f.session.connected, false);
  assert.equal(f.children[0].killed, false);
  assert.equal(f.session.terminal, terminal);
  assert.equal(f.destroyed.length, 0);
  assert.equal(f.closes, 0);
  await access(tokenFile);
  assert.equal(
    f.events.filter((event) => event.type === "disconnected").length,
    1,
  );
  await f.session.close();
  assert.equal(f.children[0].killed, true);
  assert.deepEqual(f.destroyed, [terminal]);
  await assert.rejects(access(tokenFile));
});

test("disconnect during unacknowledged resume leaves potentially running turn for manager policy", async (t) => {
  const f = fixture();
  t.after(() => f.session.close());
  await f.session.start();
  await f.session.send({ type: "task", prompt: "first", round: 1 });
  finished(f);
  await tick();
  const response = deferred<unknown>();
  f.handlers.set("turn/start", () => response.promise);
  const sending = f.session.send({ type: "task", prompt: "resume", round: 2 });
  const rejected = assert.rejects(async () => {
    await sending;
  }, /lost control/);
  await tick();
  f.disconnect();
  response.reject(new Error("lost control before acknowledgement"));
  await rejected;
  await tick();
  assert.equal(f.children[0].killed, false);
  assert.equal(f.closes, 0);
  await access(must(f.argv.at(-1)));
  assert.equal(
    f.events.find((event) => event.type === "disconnected")?.round,
    2,
  );
  assert.equal(
    f.events.filter((event) => event.type === "completed").length,
    1,
  );
  await f.session.close();
  assert.equal(f.children[0].killed, true);
});

test("cancel awaiting preflight read completes stopped without dispatch or interrupt", async (t) => {
  const f = fixture();
  t.after(() => f.session.close());
  await f.session.start();
  const read = deferred<unknown>();
  f.handlers.set("thread/read", () => read.promise);
  const sending = f.session.send({
    type: "task",
    prompt: "must not execute tools",
    round: 1,
  });
  await tick();
  assert.equal(
    f.calls.filter((call) => call.method === "thread/read").length,
    1,
  );
  await f.session.send({ type: "cancel", round: 1 });
  assert.equal(
    f.events.some((event) => event.type === "completed"),
    false,
  );
  read.resolve({ thread: { status: { type: "idle" } } });
  await sending;
  assert.equal(
    f.calls.some(
      (call) =>
        call.method === "turn/start" || call.method === "turn/interrupt",
    ),
    false,
  );
  assert.equal(
    f.events.some((event) => event.type === "started"),
    false,
  );
  assert.equal(
    f.events.find((event) => event.type === "completed")?.canceled,
    true,
  );
  assert.equal(f.events.find((event) => event.type === "completed")?.round, 1);
  assert.equal(
    f.events.filter((event) => event.type === "session_state").at(-1)?.state,
    "idle",
  );
  assert.equal(
    f.events.filter((event) => event.type === "stats").at(-1)?.turnCount,
    0,
  );
  assert.equal(f.session.connected, true);
  f.handlers.delete("thread/read");
  await f.session.send({ type: "task", prompt: "next", round: 2 });
  finished(f);
  await tick();
  assert.equal(
    f.events.filter((event) => event.type === "completed").at(-1)?.round,
    2,
  );
});

test("close waits for a late successful attachment and owns its terminal cleanup", async (t) => {
  const f = fixture();
  t.after(() => f.session.close());
  await f.session.start();
  const start = deferred<TerminalHandle>();
  f.mux.start = async () => start.promise;
  const attaching = f.session.attachment();
  const attachmentRejected = assert.rejects(
    attaching,
    /closed or disconnected/,
  );
  let closed = false;
  const closing = f.session.close().then(() => {
    closed = true;
  });
  await tick();
  assert.equal(closed, false);
  assert.equal(f.children[0].killed, false);
  const terminal = { id: "late-terminal" };
  start.resolve(terminal);
  await attachmentRejected;
  await closing;
  assert.deepEqual(f.destroyed, [terminal]);
  assert.equal(f.session.terminal, undefined);
  assert.equal(f.children[0].killed, true);
  await f.session.close();
  assert.equal(f.destroyed.length, 1);
});

test("late attachment cleanup failure retains handle and close retries", async (t) => {
  for (const startupFails of [false, true]) {
    await t.test(
      startupFails ? "TerminalStartError" : "successful late start",
      async (t) => {
        const f = fixture();
        t.after(() => f.session.close());
        await f.session.start();
        const start = deferred<TerminalHandle>();
        f.mux.start = async () => start.promise;
        let failDestroy = true;
        const attempts: TerminalHandle[] = [];
        f.mux.destroy = async (terminal) => {
          attempts.push(terminal);
          if (failDestroy) throw new Error("cannot destroy owned terminal");
          f.destroyed.push(terminal);
        };
        const attaching = f.session.attachment();
        const attachmentRejected = assert.rejects(
          attaching,
          startupFails ? /startup failed/ : /closed or disconnected/,
        );
        const closing = f.session.close();
        const closeRejected = assert.rejects(closing, /cannot destroy/);
        await tick();
        assert.equal(attempts.length, 0);
        const terminal = {
          id: startupFails ? "late-failed-start" : "late-success",
        };
        if (startupFails)
          start.reject(
            new TerminalStartError(terminal, new Error("spawn failed")),
          );
        else start.resolve(terminal);
        await attachmentRejected;
        await closeRejected;
        assert.equal(f.session.terminal, terminal);
        assert.deepEqual(attempts, [terminal]);
        failDestroy = false;
        const retry = f.session.close();
        assert.notEqual(retry, closing);
        await retry;
        assert.equal(f.session.terminal, undefined);
        assert.deepEqual(attempts, [terminal, terminal]);
        assert.deepEqual(f.destroyed, [terminal]);
      },
    );
  }
});

test("failed attachment startup cleanup outside close retains opaque ownership", async (t) => {
  const f = fixture();
  t.after(() => f.session.close());
  await f.session.start();
  const terminal = { id: "failed-start-owned" };
  f.mux.start = async () => {
    throw new TerminalStartError(terminal, new Error("spawn failed"));
  };
  const destroy = f.mux.destroy;
  f.mux.destroy = async () => {
    throw new Error("startup cleanup failed");
  };
  await assert.rejects(f.session.attachment(), /startup cleanup failed/);
  assert.equal(f.session.terminal, terminal);
  await assert.rejects(async () => {
    await f.session.send({ type: "task", prompt: "must stay blocked" });
  }, /Exit the native/);
  await assert.rejects(f.session.close(), /startup cleanup failed/);
  assert.equal(f.session.terminal, terminal);
  f.mux.destroy = destroy;
  await f.session.close();
  assert.equal(f.session.terminal, undefined);
  assert.deepEqual(f.destroyed, [terminal]);
});

test("server request rejection policy is off for native/preflight and on only for dispatched managed work", async (t) => {
  const f = fixture();
  t.after(() => f.session.close());
  await f.session.start();
  assert.equal(f.shouldRejectServerRequest(), false);
  await f.session.attachment();
  assert.equal(f.shouldRejectServerRequest(), false);
  f.event("runtime/blocked", { requestMethod: "item/tool/requestUserInput" });
  assert.equal(
    f.events.some((event) => event.type === "blocked"),
    false,
  );
  f.setAlive(false);
  const read = deferred<unknown>();
  f.handlers.set("thread/read", () => read.promise);
  const response = deferred<unknown>();
  f.handlers.set("turn/start", () => response.promise);
  const sending = f.session.send({
    type: "task",
    prompt: "headless",
    round: 1,
  });
  await tick();
  assert.equal(f.shouldRejectServerRequest(), false);
  read.resolve({ thread: { status: { type: "idle" } } });
  await tick();
  assert.equal(f.shouldRejectServerRequest(), true);
  response.resolve({ turn: { id: "headless-turn" } });
  await sending;
  assert.equal(f.shouldRejectServerRequest(), true);
  finished(f, "headless-turn");
  await tick();
  assert.equal(f.shouldRejectServerRequest(), false);
});
