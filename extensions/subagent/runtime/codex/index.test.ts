import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { access, readFile, rm, stat } from "node:fs/promises";
import { PassThrough } from "node:stream";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { AgentDefinition } from "../../agents.ts";
import { SubagentManager } from "../../manager.ts";
import {
  type MuxAdapter,
  type StartOptions,
  type TerminalHandle,
  TerminalStartError,
} from "../../mux/index.ts";
import { RuntimeTaskRejectedError } from "../errors.ts";
import type { RuntimeEvent, RuntimeOptions } from "../index.ts";
import { type CodexDependencies, CodexRuntime } from "./index.ts";
import type { CodexRpc } from "./transport.ts";

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
      case "review/start":
      case "turn/start":
        return {
          turn: {
            id: `turn-${calls.filter((call) => call.method === method).length}`,
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

function sessionUpdates(f: ReturnType<typeof fixture>) {
  return f.events.filter((event) => event.type === "session_update");
}
function nativeStarted(f: ReturnType<typeof fixture>, id: string) {
  f.event("turn/started", { turn: { id, status: "inProgress" } });
}
function nativeReply(
  f: ReturnType<typeof fixture>,
  id: string,
  text: string,
  phase = "final_answer",
) {
  f.event("item/completed", {
    turnId: id,
    item: { id: `${id}-reply`, type: "agentMessage", text, phase },
  });
}

test("native hydration publishes reply before idle and manager auto-release without a view", async (t) => {
  for (const outcome of ["success", "failure", "invalid-page"] as const) {
    await t.test(outcome, async (t) => {
      const f = fixture();
      const create = f.runtime.create.bind(f.runtime);
      f.runtime.create = (options, host) =>
        create(options, {
          ...host,
          emit(event) {
            f.events.push(event);
            host.emit(event);
          },
        });
      const manager = new SubagentManager(f.mux, { runtimes: [f.runtime] });
      t.after(() => manager.close());
      const agent = manager.spawn({
        runtime: "codex",
        prompt: "Inspect",
        description: "Inspect",
        cwd: "/tmp",
        keepAlive: false,
      });
      for (
        let i = 0;
        i < 400 && manager.get(agent.id).status !== "running";
        i++
      )
        await delay(5);
      assert.equal(manager.get(agent.id).status, "running");
      finished(f);
      nativeStarted(f, "native");
      f.event("thread/status/changed", { status: { type: "active" } });
      await tick();
      assert.equal(manager.get(agent.id).status, "completed");
      assert.equal(manager.get(agent.id).viewId, undefined);
      assert.equal(f.closes, 0);
      const gate = deferred<unknown>();
      f.handlers.set("thread/items/list", () => gate.promise);
      nativeReply(f, "native", "fallback", "commentary");
      const start = f.events.length;
      finished(f, "native", { itemsView: "notLoaded" });
      f.event("thread/status/changed", { status: { type: "idle" } });
      await tick();
      assert.equal(f.closes, 0);
      assert.equal(manager.get(agent.id).sessionState, "interactive");
      assert.deepEqual(sessionUpdates(f), []);
      if (outcome === "failure")
        gate.reject(new Error("Hydration unavailable"));
      else if (outcome === "invalid-page") gate.resolve({ data: null });
      else
        gate.resolve({
          data: [
            {
              item: {
                type: "agentMessage",
                text: "native answer",
                phase: "final_answer",
              },
            },
          ],
        });
      for (
        let i = 0;
        i < 400 && manager.get(agent.id).sessionState !== "closed";
        i++
      )
        await delay(5);
      const snapshot = manager.get(agent.id);
      assert.equal(snapshot.sessionState, "closed");
      assert.equal(
        snapshot.result,
        outcome === "success" ? "native answer" : "fallback",
      );
      assert.equal(snapshot.resultSource, "user_interaction");
      assert.equal(
        snapshot.resultOutcome,
        outcome === "success" ? "completed" : "error",
      );
      const sequence = f.events
        .slice(start)
        .filter(
          (event) =>
            event.type === "session_update" ||
            (event.type === "session_state" && event.state === "idle"),
        );
      assert.deepEqual(
        sequence.map((event) => event.type),
        ["session_update", "session_state"],
      );
      assert.equal(f.closes, 1);
      nativeReply(f, "native", "late answer");
      finished(f, "native");
      assert.equal(manager.get(agent.id).result, snapshot.result);
      assert.equal(sessionUpdates(f).length, 1);
    });
  }
});

test("native results publish once only at actual completion, ignoring retry errors and stats", async (t) => {
  const f = fixture();
  t.after(() => f.session.close());
  await f.session.start();
  nativeStarted(f, "native-1");
  nativeReply(f, "native-1", "commentary", "commentary");
  nativeReply(f, "native-1", "final reply");
  f.event("error", {
    turnId: "native-1",
    error: { message: "retrying" },
    willRetry: true,
  });
  f.event("error", {
    turnId: "native-1",
    error: { message: "final error notification" },
    willRetry: false,
  });
  finished(f, "native-1", { status: "inProgress" });
  f.event("thread/status/changed", { status: { type: "idle" } });
  assert.equal(sessionUpdates(f).length, 0);
  finished(f, "native-1");
  finished(f, "native-1");
  nativeStarted(f, "native-1");
  nativeReply(f, "native-1", "late reply");
  await tick();
  assert.deepEqual(sessionUpdates(f), [
    {
      type: "session_update",
      threadId: "thread",
      runtimeSessionId: "session",
      interactionId: "native-1",
      sequence: 1,
      response: "final reply",
      outcome: "completed",
      truncated: false,
    },
  ]);
  assert.equal(
    f.events.some((event) => ["stats", "completed"].includes(event.type)),
    false,
  );
});

test("native reply hydration paginates and bounds the selected reply to 64 KiB UTF-8", async (t) => {
  const f = fixture();
  t.after(() => f.session.close());
  await f.session.start();
  nativeStarted(f, "native");
  nativeReply(f, "native", "fallback", "commentary");
  f.handlers.set("thread/items/list", (params) => {
    assert.equal(params.turnId, "native");
    assert.equal(params.sortDirection, "asc");
    return params.cursor
      ? {
          data: [
            {
              item: {
                id: "final",
                type: "agentMessage",
                phase: "final_answer",
                text: `a${"😀".repeat(20_000)}`,
              },
            },
          ],
          nextCursor: null,
        }
      : { data: [], nextCursor: "next" };
  });
  finished(f, "native", { itemsView: "notLoaded" });
  await tick();
  const update = must(sessionUpdates(f)[0]);
  assert.equal(update.response, `a${"😀".repeat(16_383)}`);
  assert.ok(Buffer.byteLength(String(update.response)) <= 64 * 1024);
  assert.equal(update.truncated, true);
  assert.equal(update.outcome, "completed");
  assert.equal(
    f.calls.filter((call) => call.method === "thread/items/list").length,
    2,
  );
});

test("native terminal items override cached replies; empty finals and review output are authoritative", async (t) => {
  const f = fixture();
  t.after(() => f.session.close());
  await f.session.start();
  nativeStarted(f, "empty");
  nativeReply(f, "empty", "x".repeat(70_000), "commentary");
  finished(f, "empty", {
    itemsView: "notLoaded",
    items: [
      {
        id: "empty-final",
        type: "agentMessage",
        phase: "final_answer",
        text: "",
      },
    ],
  });
  nativeStarted(f, "review");
  nativeReply(f, "review", "not the review");
  finished(f, "review", {
    items: [
      { id: "review-exit", type: "exitedReviewMode", review: "review result" },
    ],
  });
  await tick();
  assert.deepEqual(
    sessionUpdates(f).map(({ response, truncated, sequence }) => ({
      response,
      truncated,
      sequence,
    })),
    [
      { response: "", truncated: false, sequence: 1 },
      { response: "review result", truncated: false, sequence: 2 },
    ],
  );
  assert.equal(
    f.calls.some((call) => call.method === "thread/items/list"),
    false,
  );
});

test("native review hydrates its authoritative output even after a final agent message", async (t) => {
  const f = fixture();
  t.after(() => f.session.close());
  await f.session.start();
  nativeStarted(f, "review");
  f.event("item/started", {
    turnId: "review",
    item: { id: "review-entry", type: "enteredReviewMode" },
  });
  nativeReply(f, "review", "intermediate final");
  f.handlers.set("thread/items/list", () => ({
    data: [
      { item: { id: "review-exit", type: "exitedReviewMode", review: "" } },
    ],
    nextCursor: null,
  }));
  finished(f, "review", { itemsView: "notLoaded" });
  await tick();
  assert.equal(sessionUpdates(f)[0].response, "");
  assert.equal(sessionUpdates(f)[0].outcome, "completed");
  assert.equal(
    f.calls.filter((call) => call.method === "thread/items/list").length,
    1,
  );
});

test("native hydration rejects invalid pages and repeated cursors with one error result", async (t) => {
  for (const invalid of [true, false]) {
    await t.test(`invalid page: ${invalid}`, async (t) => {
      const f = fixture();
      t.after(() => f.session.close());
      await f.session.start();
      f.handlers.set("thread/items/list", () =>
        invalid ? { data: null } : { data: [], nextCursor: "repeat" },
      );
      // A completion with full turn identity can recover a missed start.
      finished(f, "native", { itemsView: "notLoaded" });
      await tick();
      assert.equal(sessionUpdates(f).length, 1);
      assert.equal(sessionUpdates(f)[0].sequence, 1);
      assert.equal(sessionUpdates(f)[0].outcome, "error");
      assert.equal(
        sessionUpdates(f)[0].error,
        invalid
          ? "Invalid Codex item page"
          : "Codex item pagination limit exceeded",
      );
      finished(f, "native");
      assert.equal(sessionUpdates(f).length, 1);
      assert.equal(f.session.connected, true);
    });
  }
});

test("native interrupted, failed, and hydration-failed turns publish terminal outcomes without disconnect", async (t) => {
  const f = fixture();
  t.after(() => f.session.close());
  await f.session.start();
  nativeStarted(f, "aborted");
  nativeReply(f, "aborted", "partial", "commentary");
  finished(f, "aborted", { status: "interrupted" });
  nativeStarted(f, "failed");
  finished(f, "failed", {
    status: "failed",
    error: { message: "turn failure" },
  });
  nativeStarted(f, "hydrate-failed");
  nativeReply(f, "hydrate-failed", "fallback", "commentary");
  f.handlers.set("thread/items/list", () => {
    throw new Error("read failure");
  });
  finished(f, "hydrate-failed", { itemsView: "notLoaded" });
  await tick();
  assert.deepEqual(
    sessionUpdates(f).map(({ response, outcome, error }) => ({
      response,
      outcome,
      error,
    })),
    [
      { response: "partial", outcome: "aborted", error: undefined },
      { response: "", outcome: "error", error: "turn failure" },
      { response: "fallback", outcome: "error", error: "read failure" },
    ],
  );
  assert.equal(f.session.connected, true);
});

test("newer native starts suppress delayed hydration and late completion of older native turns", async (t) => {
  const f = fixture();
  t.after(() => f.session.close());
  await f.session.start();
  const hydration = deferred<unknown>();
  f.handlers.set("thread/items/list", () => hydration.promise);
  nativeStarted(f, "old");
  finished(f, "old", { itemsView: "notLoaded" });
  nativeStarted(f, "new");
  finished(f, "old");
  nativeReply(f, "new", "new result");
  finished(f, "new");
  hydration.resolve({
    data: [
      {
        item: {
          id: "old-final",
          type: "agentMessage",
          text: "old result",
          phase: "final_answer",
        },
      },
    ],
    nextCursor: null,
  });
  await tick();
  assert.deepEqual(
    sessionUpdates(f).map(({ interactionId, sequence, response }) => ({
      interactionId,
      sequence,
      response,
    })),
    [{ interactionId: "new", sequence: 2, response: "new result" }],
  );
  nativeStarted(f, "superseded");
  nativeStarted(f, "latest");
  finished(f, "superseded");
  nativeReply(f, "latest", "latest result");
  finished(f, "latest");
  assert.equal(sessionUpdates(f).length, 2);
  assert.equal(sessionUpdates(f)[1].sequence, 4);
});

test("stale native hydration cannot publish idle over a newer turn or managed round", async (t) => {
  for (const replacement of ["native", "managed"] as const) {
    for (const failure of [false, true]) {
      await t.test(
        `${replacement}/${failure ? "failure" : "success"}`,
        async (t) => {
          const f = fixture();
          t.after(() => f.session.close());
          await f.session.start();
          const gate = deferred<unknown>();
          f.handlers.set("thread/items/list", () => gate.promise);
          nativeStarted(f, "old");
          f.event("thread/status/changed", { status: { type: "active" } });
          finished(f, "old", { itemsView: "notLoaded" });
          f.event("thread/status/changed", { status: { type: "idle" } });
          if (replacement === "native") {
            nativeStarted(f, "new");
            f.event("thread/status/changed", { status: { type: "active" } });
          } else await f.session.send({ type: "task", prompt: "managed" });
          const start = f.events.length;
          if (failure) gate.reject(new Error("Old hydration failed"));
          else gate.resolve({ data: [] });
          await tick();
          assert.deepEqual(f.events.slice(start), []);
          assert.deepEqual(sessionUpdates(f), []);
        },
      );
    }
  }
});

test("accepted managed dispatch suppresses old native hydration", async (t) => {
  const f = fixture();
  t.after(() => f.session.close());
  await f.session.start();
  const hydration = deferred<unknown>();
  const preflight = deferred<unknown>();
  f.handlers.set("thread/items/list", () => hydration.promise);
  f.handlers.set("thread/read", () => preflight.promise);
  nativeStarted(f, "old-native");
  finished(f, "old-native", { itemsView: "notLoaded" });
  const sending = f.session.send({
    type: "task",
    prompt: "managed",
    round: 10,
  });
  await tick();
  preflight.resolve({ thread: { status: { type: "idle" } } });
  await sending;
  hydration.resolve({ data: [], nextCursor: null });
  await tick();
  assert.equal(sessionUpdates(f).length, 0);
  finished(f);
  await tick();
  // Replayed managed notifications must never become native interactions.
  finished(f);
  nativeStarted(f, "next-native");
  nativeReply(f, "next-native", "next");
  finished(f, "next-native");
  assert.equal(sessionUpdates(f).length, 1);
  assert.equal(sessionUpdates(f)[0].sequence, 3);
  assert.equal(completed(f).resultSequence, 2);
  assert.equal(
    f.events.filter((event) => event.type === "completed").length,
    1,
  );
});

test("rejected managed preflight preserves a pending native reply", async (t) => {
  const f = fixture();
  t.after(() => f.session.close());
  await f.session.start();
  await f.session.attachment();
  const hydration = deferred<unknown>();
  f.handlers.set("thread/items/list", () => hydration.promise);
  nativeStarted(f, "native");
  finished(f, "native", { itemsView: "notLoaded" });
  f.handlers.set("thread/read", () => ({
    thread: { status: { type: "active" } },
  }));
  await assert.rejects(
    async () => await f.session.send({ type: "task", prompt: "rejected" }),
    /not idle/,
  );
  hydration.resolve({
    data: [
      {
        item: {
          id: "reply",
          type: "agentMessage",
          phase: "final_answer",
          text: "B",
        },
      },
    ],
    nextCursor: null,
  });
  await tick();
  assert.equal(sessionUpdates(f).length, 1);
  assert.equal(sessionUpdates(f)[0].response, "B");
});

test("native completion before managed hydration has newer reply order without changing managed stats", async (t) => {
  const f = fixture();
  t.after(() => f.session.close());
  await f.session.start();
  await f.session.send({ type: "task", prompt: "managed" });
  const hydration = deferred<unknown>();
  f.handlers.set("thread/items/list", () => hydration.promise);
  finished(f, "turn-1", { itemsView: "notLoaded" });
  const statsBefore = f.events.filter((event) => event.type === "stats").length;
  nativeStarted(f, "native");
  nativeReply(f, "native", "native result");
  f.event("item/completed", {
    turnId: "native",
    item: { id: "native-tool", type: "commandExecution" },
  });
  finished(f, "native");
  assert.equal(sessionUpdates(f)[0].response, "native result");
  assert.equal(sessionUpdates(f)[0].sequence, 2);
  assert.equal(
    f.events.some((event) => event.type === "completed"),
    false,
  );
  assert.equal(
    f.events.filter((event) => event.type === "stats").length,
    statsBefore,
  );
  hydration.resolve({
    data: [
      {
        item: {
          id: "managed-final",
          type: "agentMessage",
          phase: "final_answer",
          text: "older managed result",
        },
      },
    ],
    nextCursor: null,
  });
  await tick();
  assert.equal(completed(f).result, "older managed result");
  assert.equal(completed(f).resultSequence, 1);
  assert.equal(stats(f).toolUses, 0);
  assert.equal(sessionUpdates(f).length, 1);
  assert.deepEqual(
    f.events
      .filter((event) => ["session_update", "completed"].includes(event.type))
      .map((event) => [event.type, event.sequence ?? event.resultSequence]),
    [
      ["session_update", 2],
      ["completed", 1],
    ],
  );
});

test("native hydration updates are suppressed after disconnect or close", async (t) => {
  for (const action of ["disconnect", "close"] as const) {
    await t.test(action, async (t) => {
      const f = fixture();
      t.after(() => f.session.close());
      await f.session.start();
      const hydration = deferred<unknown>();
      f.handlers.set("thread/items/list", () => hydration.promise);
      nativeStarted(f, "native");
      finished(f, "native", { itemsView: "notLoaded" });
      if (action === "disconnect") f.disconnect();
      else await f.session.close();
      hydration.resolve({ data: [], nextCursor: null });
      await tick();
      assert.equal(sessionUpdates(f).length, 0);
    });
  }
});

test("native interaction deduplication is bounded and sequence does not use managed rounds", async (t) => {
  const f = fixture();
  t.after(() => f.session.close());
  await f.session.start();
  for (let index = 0; index < 300; index++) {
    const id = `native-${index}`;
    nativeStarted(f, id);
    finished(f, id);
    finished(f, id);
  }
  assert.equal(sessionUpdates(f).length, 300);
  assert.equal(sessionUpdates(f).at(-1)?.sequence, 300);
  const state = f.session as unknown as { interactionHistory: Set<string> };
  assert.equal(state.interactionHistory.size, 256);
  assert.equal(state.interactionHistory.has("native-0"), false);
  assert.equal(state.interactionHistory.has("native-299"), true);
});

const reviewOptions = { runtimeConfig: { runtime_args: ["review"] } };
function reviewTask(
  target: unknown = { type: "uncommittedChanges" },
  round = 1,
) {
  return {
    type: "task" as const,
    prompt: "",
    runtimeParams: { review_target: target },
    round,
  };
}
function params(f: ReturnType<typeof fixture>, method: string) {
  return must(f.calls.filter((call) => call.method === method).at(-1)).params;
}
function completed(f: ReturnType<typeof fixture>) {
  return must(f.events.filter((event) => event.type === "completed").at(-1));
}
function stats(f: ReturnType<typeof fixture>) {
  return must(f.events.filter((event) => event.type === "stats").at(-1));
}

test("Codex exposes parsers and direct validate/create reject malformed runtime_args", () => {
  const runtime = new CodexRuntime();
  assert.deepEqual(runtime.parseConfig({ runtime_args: "review,search" }), {
    runtime_args: ["review", "search"],
  });
  const options = {
    id: "test",
    cwd: "/tmp",
    runtimeConfig: { runtime_args: "review," },
  };
  assert.throws(() => runtime.validate(options), /nonempty/);
  assert.throws(() => fixture(options), /nonempty/);
  assert.throws(
    () =>
      fixture({
        agent: agent({ runtimeConfig: { runtime_args: [" "] } }),
      }),
    /nonempty/,
  );
  const command = reviewTask();
  assert.deepEqual(
    runtime.parseTask(command, { ...options, ...reviewOptions }),
    command,
  );
});

test("Codex names the native thread once before the first task", async (t) => {
  const f = fixture({ sessionName: "Sub · explorer · Inspect auth" });
  t.after(() => f.session.close());
  await f.session.start();
  assert.deepEqual(params(f, "thread/name/set"), {
    threadId: "thread",
    name: "Sub · explorer · Inspect auth",
  });
  await f.session.send({ type: "task", prompt: "First" });
  finished(f);
  await tick();
  await f.session.send({ type: "task", prompt: "Follow up" });
  assert.equal(
    f.calls.filter((call) => call.method === "thread/name/set").length,
    1,
  );
});

test("Codex startup rejects a failed native thread rename", async (t) => {
  const f = fixture({ sessionName: "Sub · - · Inspect auth" });
  t.after(() => f.session.close());
  f.handlers.set("thread/name/set", () => {
    throw new Error("rename failed");
  });
  await assert.rejects(f.session.start(), /rename failed/);
});

test("unknown native switches reach app-server argv; semantic review/search remain RPC mappings", async (t) => {
  for (const runtime_args of [
    "review,search,unknown-switch,exec,--enable=feature,-v,unknown-switch",
    ["review", "search", "unknown-switch", "exec", "--enable=feature", "-v"],
  ]) {
    const f = fixture({ agent: agent({ runtimeConfig: { runtime_args } }) });
    t.after(() => f.session.close());
    await f.session.start();
    assert.equal(f.argv[0], "app-server");
    assert.deepEqual(f.argv.slice(7), [
      "--unknown-switch",
      "--exec",
      "--enable=feature",
      "-v",
    ]);
    assert.deepEqual(params(f, "thread/start").config, { web_search: "live" });
    await f.session.send(reviewTask());
    assert.deepEqual(params(f, "review/start"), {
      threadId: "thread",
      target: { type: "uncommittedChanges" },
      delivery: "inline",
    });
    finished(f);
    await tick();
  }
});

test("native CLI switch rejection surfaces child exit and cleans failed startup resources", async (t) => {
  const f = fixture(
    { runtimeConfig: { runtime_args: ["unknown-switch"] } },
    {
      async connect() {
        // Simulate Codex CLI rejecting an unknown flag before opening its socket.
        const child = must(f.children[0]);
        child.exitCode = 2;
        child.emit("exit", 2, null);
        throw new Error("Native CLI rejected --unknown-switch");
      },
    },
  );
  t.after(() => f.session.close());
  await assert.rejects(f.session.start(), /startup aborted/);
  assert.deepEqual(f.argv.slice(7), ["--unknown-switch"]);
  assert.equal(f.session.connected, false);
  assert.equal(f.children.length, 1);
  assert.equal(f.calls.length, 0);
  assert.equal(f.children[0].killed, false);
  const tokenFile = must(f.argv[f.argv.indexOf("--ws-token-file") + 1]);
  await assert.rejects(access(tokenFile));
  assert.match(
    String(must(f.events.find((event) => event.type === "disconnected")).error),
    /app-server exited \(2\)/,
  );
  assert.equal(
    f.events.some((event) => event.type === "completed"),
    false,
  );
});

test("search maps to live web_search thread config alongside effort and agent body", async (t) => {
  for (const thinking of [undefined, "high"]) {
    const f = fixture({
      agent: agent({ thinking, runtimeConfig: { runtime_args: "search" } }),
    });
    t.after(() => f.session.close());
    await f.session.start();
    assert.deepEqual(params(f, "thread/start").config, {
      web_search: "live",
      ...(thinking ? { model_reasoning_effort: thinking } : {}),
    });
    assert.equal(
      params(f, "thread/start").developerInstructions,
      "developer rules",
    );
    assert.equal(f.argv.includes("search"), false);
    await f.session.send({ type: "task", prompt: "Search the web" });
    assert.deepEqual(params(f, "turn/start").input, [
      { type: "text", text: "Search the web", text_elements: [] },
    ]);
    finished(f);
    await tick();
  }
});

test("direct review send validates before preflight and requires a target on resume", async (t) => {
  const f = fixture(reviewOptions);
  t.after(() => f.session.close());
  await f.session.start();
  const count = f.calls.length;
  for (const command of [
    { type: "task" as const, prompt: "" },
    { ...reviewTask(), prompt: "not supported" },
    reviewTask({ type: "commit", sha: "" }),
  ])
    await assert.rejects(async () => {
      await f.session.send(command);
    }, RuntimeTaskRejectedError);
  assert.equal(f.calls.length, count);
  await f.session.send(reviewTask());
  assert.deepEqual(params(f, "review/start"), {
    threadId: "thread",
    target: { type: "uncommittedChanges" },
    delivery: "inline",
  });
  assert.equal(
    f.calls.some((call) => call.method === "turn/start"),
    false,
  );
  finished(f, "turn-1", {
    items: [
      { id: "review-1", type: "exitedReviewMode", review: "No findings" },
    ],
  });
  await tick();
  assert.equal(completed(f).result, "No findings");
  const resumeCount = f.calls.length;
  await assert.rejects(async () => {
    await f.session.send({ type: "task", prompt: "", round: 2 });
  }, /every task/);
  assert.equal(f.calls.length, resumeCount);
  assert.equal(f.session.connected, true);
  await f.session.send(reviewTask({ type: "commit", sha: "abc" }, 2));
  assert.deepEqual(params(f, "review/start"), {
    threadId: "thread",
    target: { type: "commit", sha: "abc", title: null },
    delivery: "inline",
  });
  finished(f, "turn-2");
  await tick();
  assert.equal(
    f.calls.filter((call) => call.method === "thread/start").length,
    1,
  );
});

test("normal direct send rejects review_target and blank prompt without RPC dispatch", async (t) => {
  const f = fixture();
  t.after(() => f.session.close());
  await f.session.start();
  const count = f.calls.length;
  await assert.rejects(async () => {
    await f.session.send({ ...reviewTask(), prompt: "work" });
  }, /requires runtime_args: review/);
  await assert.rejects(async () => {
    await f.session.send({ type: "task", prompt: " " });
  }, /nonempty/);
  assert.equal(f.calls.length, count);
});

test("custom native review consumes prompt exactly once through repeated parsing and send", async (t) => {
  const options = {
    id: "test",
    cwd: "/tmp",
    runtimeConfig: { runtime_args: "review,search" },
    agent: agent(),
  };
  const f = fixture(options);
  t.after(() => f.session.close());
  await f.session.start();
  let command = f.runtime.parseTask(
    {
      ...reviewTask({ type: "custom", instructions: "Review this patch" }),
      prompt: "Check security",
    },
    options,
  );
  command = f.runtime.parseTask(command, options);
  await f.session.send(command);
  assert.deepEqual(params(f, "review/start"), {
    threadId: "thread",
    delivery: "inline",
    target: {
      type: "custom",
      instructions: "Review this patch\n\nCheck security",
    },
  });
  assert.equal(
    params(f, "thread/start").developerInstructions,
    "developer rules",
  );
  assert.deepEqual(params(f, "thread/start").config, { web_search: "live" });
  finished(f);
  await tick();
});

test("native review caches early exitedReviewMode, prioritizes review output, and excludes review markers from tools", async (t) => {
  const f = fixture(reviewOptions);
  t.after(() => f.session.close());
  await f.session.start();
  f.handlers.set("review/start", () => {
    for (const item of [
      { id: "enter", type: "enteredReviewMode", review: "Reviewing changes" },
      { id: "tool", type: "commandExecution" },
      {
        id: "message",
        type: "agentMessage",
        text: "intermediate",
        phase: "final_answer",
      },
      { id: "exit", type: "exitedReviewMode", review: "Review findings" },
    ])
      f.event("item/completed", { turnId: "turn-1", item });
    return { turn: { id: "turn-1" }, reviewThreadId: "thread" };
  });
  await f.session.send(reviewTask({ type: "baseBranch", branch: "main" }));
  finished(f, "turn-1", { itemsView: "notLoaded" });
  await tick();
  assert.equal(completed(f).result, "Review findings");
  assert.equal(stats(f).toolUses, 1);
  assert.equal(f.events.filter((event) => event.type === "activity").length, 1);
  assert.equal(
    f.calls.some((call) => call.method === "thread/items/list"),
    false,
  );
});

test("native review hydrates paginated exitedReviewMode despite intermediate final agentMessage", async (t) => {
  const f = fixture(reviewOptions);
  t.after(() => f.session.close());
  await f.session.start();
  f.handlers.set("thread/items/list", (params) =>
    params.cursor
      ? {
          data: [
            {
              item: {
                id: "exit",
                type: "exitedReviewMode",
                review: "é".repeat(40000),
              },
            },
          ],
          nextCursor: null,
        }
      : {
          data: [
            {
              item: { id: "enter", type: "enteredReviewMode", review: "start" },
            },
          ],
          nextCursor: "next",
        },
  );
  await f.session.send(reviewTask());
  finished(f, "turn-1", {
    itemsView: "notLoaded",
    items: [
      {
        id: "message",
        type: "agentMessage",
        phase: "final_answer",
        text: "wrong output",
      },
    ],
  });
  await tick();
  assert.equal(completed(f).result, "é".repeat(32768));
  assert.equal(completed(f).truncated, true);
  assert.equal(
    f.calls.filter((call) => call.method === "thread/items/list").length,
    2,
  );
  assert.equal(stats(f).toolUses, 0);
});

test("empty exited review output is authoritative and native turn output stays separate", async (t) => {
  const f = fixture(reviewOptions);
  t.after(() => f.session.close());
  await f.session.start();
  await f.session.send(reviewTask());
  f.event("item/completed", {
    turnId: "native",
    item: {
      id: "native-exit",
      type: "exitedReviewMode",
      review: "not managed",
    },
  });
  finished(f, "turn-1", {
    items: [
      { id: "message", type: "agentMessage", text: "intermediate" },
      { id: "exit", type: "exitedReviewMode", review: "" },
    ],
  });
  await tick();
  assert.equal(completed(f).result, "");
});

test("native review preserves steer, cancel before acknowledgment, and attachment reservation", async (t) => {
  const f = fixture(reviewOptions);
  t.after(() => f.session.close());
  await f.session.start();
  const response = deferred<unknown>();
  f.handlers.set("review/start", () => response.promise);
  const sending = f.session.send(reviewTask());
  await tick();
  await f.session.send({ type: "cancel", round: 1 });
  const attaching = f.session.attachment();
  await tick();
  assert.equal(f.starts.length, 0);
  assert.equal(
    f.calls.some((call) => call.method === "turn/interrupt"),
    false,
  );
  response.resolve({ turn: { id: "review-turn" }, reviewThreadId: "thread" });
  await sending;
  await attaching;
  await f.session.send({
    type: "steer",
    message: "Focus on security",
    round: 1,
  });
  assert.deepEqual(params(f, "turn/steer"), {
    threadId: "thread",
    expectedTurnId: "review-turn",
    input: [{ type: "text", text: "Focus on security", text_elements: [] }],
  });
  assert.deepEqual(params(f, "turn/interrupt"), {
    threadId: "thread",
    turnId: "review-turn",
  });
  finished(f, "review-turn", {
    status: "interrupted",
    items: [{ id: "exit", type: "exitedReviewMode", review: "Stopped" }],
  });
  await tick();
  assert.equal(completed(f).canceled, true);
  assert.equal(completed(f).result, "Stopped");
});

test("validate rejects cross-runtime clones and invalid supported thinking", () => {
  const runtime = new CodexRuntime();
  const base = { id: "test", cwd: "/tmp" };
  for (const extra of [{ parentSession: {} }, { thinking: "ultra" }])
    assert.throws(() =>
      runtime.validate({ ...base, ...extra } as RuntimeOptions),
    );
  runtime.validate({
    ...base,
    thinking: "off",
    agent: agent(),
  });
});

test("Codex ignores Pi runtime config fields regardless of their values", () => {
  const runtime = new CodexRuntime();
  const base = { id: "test", cwd: "/tmp" };
  for (const field of [
    "prompt_mode",
    "inherit_context",
    "tools",
    "disallowed_tools",
  ])
    for (const value of ["replace", "append", true, false, null, [], 12]) {
      const runtimeConfig = { [field]: value };
      runtime.validate({ ...base, agent: agent({ runtimeConfig }) });
      runtime.validate({ ...base, runtimeConfig });
      for (const phase of ["spawn", "resume"] as const)
        assert.deepEqual(runtime.parseCallConfig(runtimeConfig, {}, phase), {
          runtimeConfig: { runtime_args: [] },
          runtimeParams: {},
        });
    }
  runtime.validate({ ...base, agent: agent() });
});

test("unsupported options are ignored without changing Codex policy or task tools", async (t) => {
  const rawAgent = {
    ...agent(),
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

test("startup failures kill child and delete token and report CLI version", async () => {
  const f = fixture();
  f.handlers.set("initialize", () => {
    throw new Error("bad handshake");
  });
  await assert.rejects(f.session.start(), /codex-cli 0\.160\.0.*bad handshake/);
  assert.equal(f.session.connected, false);
  assert.equal(f.children[0].killed, true);
  await assert.rejects(access(must(f.argv.at(-1))));
  assert.equal(
    f.events.some((event) => event.type === "disconnected"),
    true,
  );
  await f.session.close();
});

for (const version of [
  "codex-cli 0.159.0",
  "codex-cli 0.160.1",
  "codex-cli 1.0.0",
  "codex-cli development",
]) {
  test(`startup accepts compatible protocol regardless of version: ${version}`, async (t) => {
    const f = fixture(
      {},
      {
        async probe() {
          return version;
        },
      },
    );
    t.after(() => f.session.close());
    await f.session.start();
    assert.equal(f.session.connected, true);
    assert.equal(f.children.length, 1);
    assert.ok(f.calls.some((call) => call.method === "initialize"));
    assert.ok(f.calls.some((call) => call.method === "thread/start"));
  });
}

test("startup rejects incompatible initialize response regardless of version", async (t) => {
  const f = fixture(
    {},
    {
      async probe() {
        return "codex-cli 0.160.1";
      },
    },
  );
  t.after(() => f.session.close());
  f.handlers.set("initialize", () => ({}));
  await assert.rejects(
    f.session.start(),
    /codex-cli 0\.160\.1.*Incompatible Codex initialize response/,
  );
  assert.equal(f.session.connected, false);
  assert.equal(f.children[0].killed, true);
  await assert.rejects(access(must(f.argv.at(-1))));
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

test("native attachment retains backend on detach and allows idle managed sends", async (t) => {
  const definition = agent();
  const f = fixture({ agent: definition });
  t.after(() => f.session.close());
  await f.session.start();
  const terminal = await f.session.attachment();
  assert.equal(f.session.terminal, terminal);
  assert.equal(await f.session.attachment(), terminal);
  assert.equal(f.starts[0].env.PI_KITS_SUBAGENT_WORKER, "1");
  assert.equal(f.starts[0].agentType, definition.name);
  assert.deepEqual(f.starts[0].argv.slice(-2), ["resume", "thread"]);
  assert.equal(f.starts[0].argv.includes(f.token), false);
  await f.mux.close_view({ id: "view" });
  await f.session.send({ type: "task", prompt: "allowed with live TUI" });
  assert.equal(f.session.terminal, terminal);
  assert.deepEqual(f.destroyed, []);
  finished(f);
  await tick();
  await f.session.send({ type: "cancel" });
  assert.equal(
    f.calls.some((call) => call.method === "turn/interrupt"),
    false,
  );
  assert.equal(f.closes, 0);
  f.setAlive(false);
  await f.session.send({ type: "task", prompt: "allowed" });
  assert.deepEqual(f.destroyed, []);
  const next = await f.session.attachment();
  assert.deepEqual(f.destroyed, [terminal]);
  f.setAlive(true);
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

test("guardian stop requests must confirm exit and retain cleanup ownership on timeout", async (t) => {
  for (const acceptsIpc of [true, false]) {
    await t.test(`IPC accepted: ${acceptsIpc}`, async () => {
      const signals: string[] = [];
      const child = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        exitCode: null as number | null,
        signalCode: null as string | null,
        kill(signal: string) {
          signals.push(signal); // Like the guardian: request, not actual exit.
          return acceptsIpc;
        },
      });
      const removed: string[] = [];
      const f = fixture(
        {},
        {
          spawn: () => child as unknown as ChildProcess,
          async removeDirectory(path) {
            removed.push(path);
            await rm(path, { recursive: true, force: true });
          },
        },
      );
      t.after(async () => {
        child.signalCode = "SIGKILL";
        child.emit("exit", null, "SIGKILL");
        await f.session.close();
      });
      await f.session.start();
      const terminal = await f.session.attachment();
      const listeners = child.listenerCount("exit");
      await assert.rejects(f.session.close(), /guardian exit unconfirmed/);
      assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
      assert.equal(child.listenerCount("exit"), listeners);
      assert.equal(f.session.terminal, terminal);
      assert.equal(f.destroyed.length, 0);
      assert.equal(removed.length, 0);
      const retry = f.session.close();
      await tick();
      assert.deepEqual(signals, ["SIGTERM", "SIGKILL", "SIGTERM"]);
      child.signalCode = "SIGKILL";
      child.emit("exit", null, "SIGKILL");
      await retry;
      assert.deepEqual(f.destroyed, [terminal]);
      assert.equal(removed.length, 1);
      assert.equal(f.session.terminal, undefined);
    });
  }
});

test("forced guardian request still waits for the eventual exit event", async (t) => {
  const signals: string[] = [];
  let forceRequested = () => {};
  const forced = new Promise<void>((resolve) => {
    forceRequested = resolve;
  });
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null as number | null,
    signalCode: null as string | null,
    kill(signal: string) {
      signals.push(signal);
      if (signal === "SIGKILL") forceRequested();
      return true;
    },
  });
  const f = fixture({}, { spawn: () => child as unknown as ChildProcess });
  t.after(async () => {
    child.signalCode = "SIGKILL";
    child.emit("exit", null, "SIGKILL");
    await f.session.close();
  });
  await f.session.start();
  const terminal = await f.session.attachment();
  let closed = false;
  const closing = f.session.close().then(() => {
    closed = true;
  });
  await forced;
  assert.equal(closed, false);
  assert.equal(f.session.terminal, terminal);
  assert.equal(f.destroyed.length, 0);
  child.signalCode = "SIGKILL";
  child.emit("exit", null, "SIGKILL");
  await closing;
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
  assert.deepEqual(f.destroyed, [terminal]);
});

test("failed native destroy retains opaque handle without restricting idle submit", async (t) => {
  const f = fixture();
  t.after(() => f.session.close());
  await f.session.start();
  const terminal = await f.session.attachment();
  f.setAlive(false);
  const destroy = f.mux.destroy;
  f.mux.destroy = async () => {
    throw new Error("ownership cleanup failed");
  };
  await assert.rejects(f.session.attachment(), /cleanup failed/);
  assert.equal(f.session.terminal, terminal);
  await f.session.send({ type: "task", prompt: "go" });
  assert.equal(
    f.calls.some((call) => call.method === "turn/start"),
    true,
  );
  f.mux.destroy = destroy;
});

test("idle managed task can dispatch while native attachment is opening", async (t) => {
  const f = fixture();
  t.after(() => f.session.close());
  await f.session.start();
  const pending = deferred<TerminalHandle>();
  f.mux.start = async () => pending.promise;
  const attaching = f.session.attachment();
  await tick();
  await f.session.send({ type: "task", prompt: "idle continuation" });
  assert.equal(
    f.calls.some((call) => call.method === "turn/start"),
    true,
  );
  pending.resolve({ id: "native-opening" });
  await attaching;
  assert.equal(f.session.terminal?.id, "native-opening");
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
  f.handlers.set("thread/read", () => ({
    thread: { status: { type: "active" } },
  }));
  await assert.rejects(async () => {
    await f.session.send({ type: "task", prompt: "blocked", round: 1 });
  }, RuntimeTaskRejectedError);
  assert.equal(
    f.events.some((event) => event.type === "disconnected"),
    false,
  );
  assert.equal(f.session.connected, true);
  f.handlers.delete("thread/read");
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
  assert.equal(completed(f).resultSequence, 1);
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
  await f.session.send({
    type: "task",
    prompt: "idle task with owned terminal",
  });
  finished(f);
  await tick();
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
  assert.equal(await f.shouldRejectServerRequest(), true);
  response.resolve({ turn: { id: "headless-turn" } });
  await sending;
  assert.equal(await f.shouldRejectServerRequest(), true);
  finished(f, "headless-turn");
  await tick();
  assert.equal(f.shouldRejectServerRequest(), false);
});
