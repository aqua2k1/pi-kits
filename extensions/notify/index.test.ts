import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
  MessageEndEvent,
} from "@earendil-works/pi-coding-agent";
import { useAgentDir } from "../../tests/helpers/agent-dir.ts";
import notifyExtension, {
  type CompletionNotificationDependencies,
  NOTIFICATION_QUIET_PERIOD_MS,
  registerCompletionNotification,
} from "./index.ts";

type EventHandler = (
  event: { type: string; message?: MessageEndEvent["message"] },
  ctx: ExtensionContext,
) => unknown | Promise<unknown>;

function captureHandlers(dependencies: CompletionNotificationDependencies): {
  events: string[];
  handler(event: string): EventHandler;
} {
  const events: string[] = [];
  const handlers = new Map<string, EventHandler>();
  const pi = {
    on(event: string, handler: EventHandler) {
      events.push(event);
      handlers.set(event, handler);
    },
  } as unknown as ExtensionAPI;

  registerCompletionNotification(pi, dependencies);
  return {
    events,
    handler(event) {
      const handler = handlers.get(event);
      assert.ok(handler, `${event} handler was not registered`);
      return handler;
    },
  };
}

function context(
  mode: "tui" | "rpc" | "json" | "print" = "tui",
  idle = true,
): ExtensionContext {
  return { mode, isIdle: () => idle } as ExtensionContext;
}

function immediateDependencies(
  overrides: Partial<CompletionNotificationDependencies> = {},
): CompletionNotificationDependencies {
  return {
    notify: () => undefined,
    schedule(callback) {
      callback();
      return () => undefined;
    },
    ...overrides,
  };
}

test("registerCompletionNotification: registers lifecycle hooks", () => {
  const { events } = captureHandlers(immediateDependencies());
  assert.deepEqual(events, [
    "input",
    "before_agent_start",
    "agent_start",
    "session_shutdown",
    "session_start",
    "message_end",
    "agent_settled",
  ]);
});

test("registerCompletionNotification: notifies only the idle TUI", async () => {
  const notifications: Array<[string, string]> = [];
  const { handler } = captureHandlers(
    immediateDependencies({
      notify: (title, msg) => {
        notifications.push([title, msg]);
      },
    }),
  );

  await handler("agent_settled")({ type: "agent_settled" }, context());
  for (const mode of ["rpc", "json", "print"] as const) {
    await handler("agent_settled")({ type: "agent_settled" }, context(mode));
  }
  await handler("agent_settled")(
    { type: "agent_settled" },
    context("tui", false),
  );

  assert.deepEqual(notifications, [["Pi", "Task completed."]]);
});

function assistantMessage(
  overrides: Partial<AssistantMessage> = {},
): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "Updated the notification extension." }],
    stopReason: "stop",
    ...overrides,
  } as AssistantMessage;
}

for (const [stopReason, errorMessage, expected] of [
  ["stop", undefined, "Task completed."],
  ["error", "HTTP 401: Invalid API key", "Task failed."],
  ["error", undefined, "Task failed."],
  ["error", "  ", "Task failed."],
  ["aborted", "Request cancelled", "Task aborted."],
  ["aborted", undefined, "Task aborted."],
  ["length", undefined, "Response truncated (token limit)."],
] as const) {
  test(`notification includes only ${stopReason} status (${errorMessage})`, async () => {
    const notifications: string[] = [];
    const { handler } = captureHandlers(
      immediateDependencies({
        notify: (_title, body) => {
          notifications.push(body);
        },
      }),
    );
    await handler("message_end")(
      {
        type: "message_end",
        message: assistantMessage({ stopReason, errorMessage }),
      },
      context(),
    );
    assert.deepEqual(notifications, []);
    await handler("agent_settled")({ type: "agent_settled" }, context());
    assert.deepEqual(notifications, [expected]);
  });
}

test("notification uses the recovered final response, ignoring tool results", async () => {
  const notifications: string[] = [];
  const { handler } = captureHandlers(
    immediateDependencies({
      notify: (_title, body) => {
        notifications.push(body);
      },
    }),
  );
  for (const message of [
    assistantMessage({
      stopReason: "error",
      errorMessage: "Temporary failure",
    }),
    assistantMessage(),
    {
      role: "toolResult",
      isError: true,
      content: [{ type: "text", text: "tool error" }],
    } as MessageEndEvent["message"],
  ]) {
    await handler("message_end")({ type: "message_end", message }, context());
  }
  await handler("agent_settled")({ type: "agent_settled" }, context());
  assert.deepEqual(notifications, ["Task completed."]);
});

test("notification excludes response text, thinking and tool calls", async () => {
  const notifications: string[] = [];
  const { handler } = captureHandlers(
    immediateDependencies({
      notify: (_title, body) => {
        notifications.push(body);
      },
    }),
  );
  await handler("message_end")(
    {
      type: "message_end",
      message: assistantMessage({
        content: [
          { type: "thinking", thinking: "private reasoning" },
          {
            type: "toolCall",
            id: "1",
            name: "bash",
            arguments: { command: "secret" },
          },
          { type: "text", text: `  Summary\n\t${"😀".repeat(400)}  ` },
        ],
      }),
    },
    context(),
  );
  await handler("agent_settled")({ type: "agent_settled" }, context());
  assert.deepEqual(notifications, ["Task completed."]);
});

for (const event of [
  "before_agent_start",
  "session_start",
  "session_shutdown",
]) {
  test(`notification clears stale errors on ${event}`, async () => {
    const notifications: string[] = [];
    const { handler } = captureHandlers(
      immediateDependencies({
        notify: (_title, body) => {
          notifications.push(body);
        },
      }),
    );
    await handler("message_end")(
      {
        type: "message_end",
        message: assistantMessage({
          stopReason: "error",
          errorMessage: "Old failure",
        }),
      },
      context(),
    );
    await handler(event)({ type: event }, context());
    await handler("agent_settled")({ type: "agent_settled" }, context());
    assert.deepEqual(notifications, ["Task completed."]);
  });
}

test("registerCompletionNotification: applies the idle quiet period", async () => {
  let delay: number | undefined;
  const { handler } = captureHandlers({
    notify: () => undefined,
    schedule(_callback, delayMs) {
      delay = delayMs;
      return () => undefined;
    },
  });

  await handler("agent_settled")({ type: "agent_settled" }, context());
  assert.equal(delay, NOTIFICATION_QUIET_PERIOD_MS);
});

test("registerCompletionNotification: cancels when a continuation begins", async () => {
  let count = 0;
  const scheduled: Array<{ active: boolean; callback: () => void }> = [];
  const { handler } = captureHandlers({
    notify: () => {
      count += 1;
    },
    schedule(callback) {
      const entry = { active: true, callback };
      scheduled.push(entry);
      return () => {
        entry.active = false;
      };
    },
  });

  await handler("agent_settled")({ type: "agent_settled" }, context());
  await handler("before_agent_start")(
    { type: "before_agent_start" },
    context(),
  );
  for (const entry of scheduled) {
    if (entry.active) entry.callback();
  }
  assert.equal(count, 0);
});

test("registerCompletionNotification: contains notifier failures", async () => {
  const sync = captureHandlers(
    immediateDependencies({
      notify: () => {
        throw new Error("notification failed");
      },
    }),
  );
  await assert.doesNotReject(async () => {
    await sync.handler("agent_settled")({ type: "agent_settled" }, context());
  });

  const asyncFailure = captureHandlers(
    immediateDependencies({
      notify: async () => {
        throw new Error("notification failed");
      },
    }),
  );
  asyncFailure.handler("agent_settled")({ type: "agent_settled" }, context());
  await setImmediate();
});

test("registerCompletionNotification: cancels all pending lifecycle notifications", async () => {
  for (const event of [
    "input",
    "before_agent_start",
    "agent_start",
    "session_shutdown",
  ]) {
    let cancelled = false;
    const { handler } = captureHandlers({
      notify: () =>
        assert.fail("Cancelled notifications must not be delivered"),
      schedule() {
        return () => {
          cancelled = true;
        };
      },
    });
    await handler("agent_settled")({ type: "agent_settled" }, context());
    await handler(event)({ type: event }, context());
    assert.equal(cancelled, true, event);
    // Shutdown or repeated cancellation remains idempotent.
    await handler(event)({ type: event }, context());
  }
});

test("registerCompletionNotification: rechecks idle state after the quiet period", async () => {
  let callback: (() => void) | undefined;
  let idle = true;
  let notifications = 0;
  const { handler } = captureHandlers({
    notify: () => {
      notifications += 1;
    },
    schedule(scheduled) {
      callback = scheduled;
      return () => undefined;
    },
  });
  const ctx = { mode: "tui", isIdle: () => idle } as ExtensionContext;
  await handler("agent_settled")({ type: "agent_settled" }, ctx);
  assert.ok(callback);
  idle = false;
  callback();
  assert.equal(notifications, 0);
});

test("registerCompletionNotification: a new settled event replaces the pending timer", async () => {
  let cancellations = 0;
  let scheduled = 0;
  const { handler } = captureHandlers({
    notify: () => undefined,
    schedule() {
      scheduled += 1;
      return () => {
        cancellations += 1;
      };
    },
  });
  await handler("agent_settled")({ type: "agent_settled" }, context());
  await handler("agent_settled")({ type: "agent_settled" }, context());
  assert.equal(scheduled, 2);
  assert.equal(cancellations, 1);
  await handler("session_shutdown")({ type: "session_shutdown" }, context());
  assert.equal(cancellations, 2);
});

for (const config of [
  { workflow: { enabled: false } },
  { workflow: { notify: { enabled: false } } },
  { notify: { enabled: false } },
]) {
  test(`disabled notify ${JSON.stringify(config)} has no hook or timer side effects`, (t) => {
    useAgentDir(t, config);
    t.mock.method(globalThis, "setTimeout", () => {
      assert.fail("Disabled notifications must not schedule timers");
    });
    notifyExtension({
      on() {
        assert.fail("Disabled notifications must not register hooks");
      },
      registerCommand() {
        assert.fail("Disabled notifications must not register commands");
      },
      registerFlag() {
        assert.fail("Disabled notifications must not register flags");
      },
    } as unknown as ExtensionAPI);
  });
}

for (const config of [
  { workflow: { notify: { quietPeriodMs: 75 } } },
  { notify: { quietPeriodMs: 75 } },
]) {
  test(`notify factory passes the configured quiet period to its lifecycle timer ${JSON.stringify(config)}`, async (t) => {
    useAgentDir(t, config);
    const handlers = new Map<string, EventHandler>();
    const delays: number[] = [];
    t.mock.method(
      globalThis,
      "setTimeout",
      (_callback: () => void, delay: number) => {
        delays.push(delay);
        return 1;
      },
    );
    t.mock.method(globalThis, "clearTimeout", () => undefined);
    notifyExtension({
      on(name: string, handler: EventHandler) {
        handlers.set(name, handler);
      },
    } as unknown as ExtensionAPI);
    const settled = handlers.get("agent_settled");
    assert.ok(settled);
    await settled({ type: "agent_settled" }, context());
    assert.deepEqual(delays, [75]);
    await handlers.get("session_shutdown")?.(
      { type: "session_shutdown" },
      context(),
    );
  });
}
