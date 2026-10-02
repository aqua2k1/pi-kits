import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  type CompletionNotificationDependencies,
  NOTIFICATION_QUIET_PERIOD_MS,
  registerCompletionNotification,
} from "./index.ts";

type EventHandler = (
  event: { type: string },
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
