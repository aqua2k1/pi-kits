import assert from "node:assert/strict";
import { test } from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import tokenMeter from "./index.ts";

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
type Widget = Parameters<ExtensionContext["ui"]["setWidget"]>[1];

function host(mode: ExtensionContext["mode"] = "tui") {
  let time = 0;
  const handlers = new Map<string, Handler>();
  const updates: Array<string | undefined> = [];
  let component: { render(width: number): string[] } | undefined;
  const draw = () => {
    updates.push(component?.render(80).join("\n").trimStart());
  };
  const pi = {
    on(name: string, handler: Handler) {
      handlers.set(name, handler);
    },
  } as unknown as ExtensionAPI;
  const ctx = {
    mode,
    ui: {
      setWidget(_key: string, widget: Widget) {
        if (widget === undefined) {
          component = undefined;
          updates.push(undefined);
          return;
        }
        assert.equal(typeof widget, "function");
        if (typeof widget !== "function") return;
        component = widget(
          { requestRender: draw } as Parameters<typeof widget>[0],
          { fg: (_tone: string, text: string) => text } as Parameters<
            typeof widget
          >[1],
        );
        draw();
      },
    },
  } as unknown as ExtensionContext;
  tokenMeter(pi, () => time);
  function emit(name: string, event: object = {}, at = time) {
    time = at;
    const handler = handlers.get(name);
    assert.ok(handler, `missing ${name}`);
    return handler({ type: name, ...event }, ctx);
  }
  function begin(at = 0, withHook = true) {
    emit("turn_start", {}, at);
    if (withHook) emit("before_provider_request", {}, at);
    emit("message_start", { message: { role: "assistant" } }, at);
  }
  function delta(type: string, text: string, at: number) {
    emit(
      "message_update",
      {
        message: { role: "assistant" },
        assistantMessageEvent: { type, delta: text },
      },
      at,
    );
  }
  function end(
    at: number,
    overrides: Partial<AssistantMessage> & { durationMs?: number } = {},
  ) {
    emit(
      "message_end",
      {
        message: {
          role: "assistant",
          stopReason: "stop",
          usage: { output: 315, reasoning: 200 },
          ...overrides,
        },
      },
      at,
    );
  }
  return { pi, handlers, updates, emit, begin, delta, end };
}

test("factory only registers passive hooks and never schedules a timer", (t) => {
  t.mock.method(globalThis, "setInterval", () => {
    assert.fail("must not create timers");
  });
  t.mock.method(globalThis, "setTimeout", () => {
    assert.fail("must not create timers");
  });
  const h = host();
  const events: string[] = [];
  tokenMeter({
    on(name: string) {
      events.push(name);
    },
  } as unknown as ExtensionAPI);
  assert.ok(events.includes("message_end"));
  h.emit("session_start");
  h.begin();
  h.delta("text_delta", "Hello", 800);
  h.end(5000);
  assert.equal(h.updates.at(-1), "TTFT 0.8s · TPS 63 token/s");
});

test("updates only on response end, counts interface output including reasoning", () => {
  const h = host();
  h.emit("session_start");
  assert.deepEqual(h.updates, ["TTFT — · TPS —"]);
  h.begin();
  h.delta("thinking_delta", "summary", 200);
  h.delta("toolcall_delta", "{}", 400);
  h.delta("text_delta", "", 600);
  h.delta("text_delta", "Hello", 800);
  h.delta("text_delta", " world", 2000);
  assert.equal(h.updates.length, 1);
  h.end(5000);
  assert.deepEqual(h.updates, ["TTFT — · TPS —", "TTFT 0.8s · TPS 63 token/s"]);
});

test("prefers Pi response duration to event-delivery time", () => {
  const h = host();
  h.begin();
  h.delta("text_delta", "Hello", 800);
  h.end(9000, { durationMs: 5000 });
  assert.deepEqual(h.updates, ["TTFT 0.8s · TPS 63 token/s"]);
});

test("tool waits and later requests do not accumulate into the next metrics", () => {
  const h = host();
  h.begin();
  h.delta("text_delta", "First", 800);
  h.end(5000, { stopReason: "toolUse" });
  h.emit("message_end", { message: { role: "toolResult" } }, 90_000);
  h.emit("turn_end");
  assert.equal(h.updates.length, 1);
  h.begin(100_000);
  assert.equal(h.updates.length, 1);
  h.delta("text_delta", "Second", 101_000);
  h.end(105_000);
  assert.deepEqual(h.updates, [
    "TTFT 0.8s · TPS 63 token/s",
    "TTFT 1.0s · TPS 63 token/s",
  ]);
});

test("a tool-only response has TPS but no visible-text TTFT", () => {
  const h = host();
  h.begin();
  h.delta("thinking_delta", "summary", 300);
  h.delta("toolcall_delta", "{}", 800);
  h.end(5000, { stopReason: "toolUse" });
  assert.deepEqual(h.updates, ["TTFT — · TPS 63 token/s"]);
});

test("missing provider hooks never reuse prior timing; Pi duration still works", () => {
  const h = host();
  h.begin();
  h.delta("text_delta", "First", 800);
  h.end(5000);
  h.begin(10_000, false);
  h.delta("text_delta", "Second", 10_800);
  h.end(15_000, { durationMs: 5000 });
  assert.equal(h.updates.at(-1), "TTFT — · TPS 63 token/s");
  h.begin(20_000, false);
  h.end(25_000);
  assert.equal(h.updates.at(-1), "TTFT — · TPS —");
});

for (const stopReason of ["error", "aborted", "deferred"] as const) {
  test(`${stopReason} responses do not report TPS`, () => {
    const h = host();
    h.begin();
    h.delta("text_delta", "Partial", 800);
    h.end(5000, { stopReason });
    assert.equal(h.updates.at(-1), "TTFT 0.8s · TPS —");
  });
}

for (const output of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
  test(`invalid or unavailable output count ${output} shows a placeholder`, () => {
    const h = host();
    h.begin();
    h.end(5000, { usage: { output } as AssistantMessage["usage"] });
    assert.equal(h.updates.at(-1), "TTFT — · TPS —");
  });
}

test("zero duration and missing usage do not produce invalid speeds", () => {
  const h = host();
  h.begin();
  h.end(0, { durationMs: 0 });
  assert.equal(h.updates.at(-1), "TTFT — · TPS —");
  h.begin();
  h.end(5000, { usage: undefined });
  assert.equal(h.updates.at(-1), "TTFT — · TPS —");
});

test("provider retries before streaming replace the request start", () => {
  const h = host();
  h.emit("turn_start");
  h.emit("before_provider_request", {}, 0);
  h.emit("before_provider_request", {}, 10_000);
  h.emit("message_start", { message: { role: "assistant" } });
  h.delta("text_delta", "Recovered", 10_800);
  h.end(15_000);
  assert.equal(h.updates.at(-1), "TTFT 0.8s · TPS 63 token/s");
});

test("overlapping provider hooks invalidate ambiguous local measurements", () => {
  const h = host();
  h.begin();
  h.delta("text_delta", "First", 800);
  h.emit("before_provider_request", {}, 1000);
  h.end(5000);
  assert.equal(h.updates.at(-1), "TTFT — · TPS —");
});

test("background calls and non-assistant messages do not change the display", () => {
  const h = host();
  h.emit("before_provider_request");
  h.emit("message_start", { message: { role: "user" } });
  h.emit("message_end", { message: { role: "user" } });
  h.end(5000);
  assert.deepEqual(h.updates, []);
});

for (const event of ["session_start", "session_shutdown", "agent_settled"]) {
  test(`${event} clears in-flight state`, () => {
    const h = host();
    h.begin();
    h.delta("text_delta", "Partial", 800);
    h.emit(event);
    const count = h.updates.length;
    h.end(5000);
    assert.equal(h.updates.length, count);
    if (event === "session_shutdown") assert.equal(h.updates.at(-1), undefined);
    if (event === "session_start") {
      assert.equal(h.updates.at(-1), "TTFT — · TPS —");
    }
  });
}

for (const mode of ["rpc", "json", "print"] as const) {
  test(`${mode} mode never renders terminal status`, () => {
    const h = host(mode);
    h.emit("session_start");
    h.begin();
    h.delta("text_delta", "Hello", 800);
    h.end(5000);
    h.emit("session_shutdown");
    assert.deepEqual(h.updates, []);
  });
}
