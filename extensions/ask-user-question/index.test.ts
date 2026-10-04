import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { type TestContext, test } from "node:test";
import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionToolContext,
  ExtensionUIContext,
  Theme,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { getKeybindings, type TUI } from "@earendil-works/pi-tui";
import {
  DOCKED_PANEL_CLOSED,
  DOCKED_PANEL_OPENED,
  type DockedPanelClosedEvent,
  type DockedPanelOpenedEvent,
} from "../../shared/ui/docked-panel/events.ts";
import { useAgentDir } from "../../tests/helpers/agent-dir.ts";
import {
  type AskUserParameters,
  type AskUserResult,
  AskUserResultSchema,
} from "./core.ts";
import {
  ASK_USER_QUESTION_END,
  ASK_USER_QUESTION_START,
  type AskUserQuestionEndEvent,
  type AskUserQuestionStartEvent,
} from "./events.ts";
import askUserQuestionExtension from "./index.ts";

type LifecycleEvent =
  | AskUserQuestionStartEvent
  | AskUserQuestionEndEvent
  | DockedPanelOpenedEvent
  | DockedPanelClosedEvent;

function capture(t: TestContext, config?: unknown) {
  useAgentDir(t, config);
  let tool: ToolDefinition<typeof AskUserParameters, AskUserResult> | undefined;
  let handler: ((event: unknown, ctx: ExtensionContext) => void) | undefined;
  let active = ["read", "ask_user_question"];
  const events: {
    name: string;
    data: LifecycleEvent;
  }[] = [];
  const pi = {
    events: {
      emit(name: string, data: LifecycleEvent) {
        events.push({ name, data });
      },
    },
    registerTool(value: typeof tool) {
      tool = value;
    },
    on(_name: string, value: typeof handler) {
      handler = value;
    },
    getActiveTools() {
      return active;
    },
    setActiveTools(value: string[]) {
      active = value;
    },
  } as unknown as ExtensionAPI;
  askUserQuestionExtension(pi);
  return {
    events,
    get tool() {
      return tool;
    },
    get handler() {
      return handler;
    },
    get active() {
      return active;
    },
  };
}

test("registers a sequential model-only tool and reconciles UI availability", (t) => {
  const captured = capture(t);
  assert.equal(captured.tool?.name, "ask_user_question");
  assert.equal(captured.tool?.executionMode, "sequential");
  assert.equal(captured.tool?.exposure, "model-only");
  for (const hasUI of [false, false, true, true]) {
    captured.handler?.({}, { hasUI } as ExtensionContext);
    assert.deepEqual(
      captured.active,
      hasUI ? ["read", "ask_user_question"] : ["read"],
    );
  }
});

test("schemas describe the contract while model guidance focuses on purpose", (t) => {
  const { tool } = capture(t);
  assert.ok(tool);
  assert.equal(tool.outputSchema, AskUserResultSchema);
  assert.equal(
    tool.description,
    "Ask the user structured questions to clarify requirements or choose an approach. Supports single-choice, multi-select, and custom answers.",
  );
  const parameters = JSON.stringify(tool.parameters);
  assert.match(parameters, /The question to ask the user/);
  assert.match(parameters, /Allow multiple options/);
  assert.match(parameters, /Explain the choice or its trade-offs/);
  const output = JSON.stringify(tool.outputSchema);
  assert.match(output, /Zero-based index/);
  assert.match(output, /user cancelled/);
  const guidance = [
    tool.description,
    tool.promptSnippet,
    ...(tool.promptGuidelines ?? []),
  ].join(" ");
  assert.doesNotMatch(
    guidance,
    /terminal|\bUI\b|fullscreen|\bRPC\b|checkbox|buttons|Left\/Right|\bSpace\b/i,
  );
  assert.doesNotMatch(guidance, /cancelled|cancellation|partial|approval/i);
});

test("factory respects kit and feature switches", (t) => {
  for (const workflow of [
    { enabled: false },
    { askUserQuestion: { enabled: false } },
  ]) {
    const captured = capture(t, { workflow });
    assert.equal(captured.tool, undefined);
    assert.equal(captured.handler, undefined);
  }
});

test("tool rejects no UI and executes in an RPC-style dialog host", async (t) => {
  const { tool } = capture(t);
  assert.ok(tool);
  const params = {
    questions: [{ question: "Choose?", options: [{ label: "A" }] }],
  };
  await assert.rejects(
    tool.execute("id", params, undefined, undefined, {
      hasUI: false,
    } as ExtensionToolContext),
    /UI unavailable/,
  );
  const ctx = {
    hasUI: true,
    mode: "rpc",
    ui: {
      async select(_title: string, rows: string[]) {
        return rows[0];
      },
      async input() {
        throw new Error("Unexpected input");
      },
    },
  } as unknown as ExtensionToolContext;
  const response = await tool.execute("id", params, undefined, undefined, ctx);
  assert.equal(response.details.cancelled, false);
  assert.equal(response.details.answers[0].answer, "A");
});

const questions = {
  questions: [{ question: "Choose?", options: [{ label: "A" }] }],
};

function rpcContext(select: () => Promise<string | undefined>) {
  return {
    hasUI: true,
    mode: "rpc",
    ui: { select },
  } as unknown as ExtensionToolContext;
}

function interceptNotifications(t: TestContext) {
  const notifications: string[][] = [];
  const mock = t.mock.method(childProcess, "execFile", (...args: unknown[]) => {
    notifications.push(args[1] as string[]);
    (args.at(-1) as (error: null) => void)(null);
  });
  syncBuiltinESMExports();
  t.after(() => {
    mock.mock.restore();
    syncBuiltinESMExports();
  });
  return notifications;
}

for (const cancelled of [false, true]) {
  test(`question hooks bracket RPC dialogs (${cancelled ? "cancelled" : "answered"})`, async (t) => {
    const { tool, events } = capture(t);
    assert.ok(tool);
    const ctx = rpcContext(async () => {
      assert.deepEqual(events, [
        {
          name: ASK_USER_QUESTION_START,
          data: { toolCallId: "id", mode: "rpc", questionCount: 1 },
        },
      ]);
      return cancelled ? undefined : "1. A";
    });
    const response = await tool.execute(
      "id",
      questions,
      undefined,
      undefined,
      ctx,
    );
    assert.deepEqual(events[1], {
      name: ASK_USER_QUESTION_END,
      data: {
        toolCallId: "id",
        mode: "rpc",
        questionCount: 1,
        status: cancelled ? "cancelled" : "answered",
        result: response.details,
      },
    });
    assert.equal(events.length, 2);
  });
}

for (const aborted of [false, true]) {
  test(`question end hook fires on ${aborted ? "abort" : "host error"}`, async (t) => {
    const { tool, events } = capture(t);
    assert.ok(tool);
    const controller = new AbortController();
    const failure = new Error("host failure");
    const ctx = rpcContext(async () => {
      if (aborted) {
        controller.abort();
        return "1. A";
      }
      throw failure;
    });
    await assert.rejects(
      tool.execute("id", questions, controller.signal, undefined, ctx),
      aborted ? { name: "AbortError" } : failure,
    );
    assert.deepEqual(
      events.map((event) => event.name),
      [ASK_USER_QUESTION_START, ASK_USER_QUESTION_END],
    );
    assert.deepEqual(events[1].data, {
      toolCallId: "id",
      mode: "rpc",
      questionCount: 1,
      status: aborted ? "aborted" : "error",
    });
  });
}

test("no UI or pre-aborted calls do not emit hooks or notify", async (t) => {
  const { tool, events } = capture(t);
  assert.ok(tool);
  const notifications = interceptNotifications(t);
  const controller = new AbortController();
  controller.abort();
  const ctx = rpcContext(async () => assert.fail("unexpected dialog"));
  await assert.rejects(
    tool.execute("id", questions, controller.signal, undefined, ctx),
    { name: "AbortError" },
  );
  await assert.rejects(
    tool.execute("id", questions, undefined, undefined, {
      hasUI: false,
    } as ExtensionToolContext),
    /UI unavailable/,
  );
  assert.deepEqual(events, []);
  assert.deepEqual(notifications, []);
});

for (const enabled of [true, false]) {
  test(`TUI question notification respects workflow.notify.enabled=${enabled}`, async (t) => {
    const { tool, events } = capture(t, {
      workflow: { notify: { enabled } },
    });
    assert.ok(tool);
    const notifications = interceptNotifications(t);
    const ctx = {
      hasUI: true,
      mode: "tui",
      ui: {
        async custom(factory: Parameters<ExtensionUIContext["custom"]>[0]) {
          assert.equal(events[0]?.name, ASK_USER_QUESTION_START);
          assert.equal(events.length, 1);
          assert.equal(notifications.length, enabled ? 1 : 0);
          let result: unknown;
          const component = await factory(
            {
              terminal: { rows: 24 },
              requestRender() {},
            } as unknown as TUI,
            { fg: (_color: string, text: string) => text } as Theme,
            getKeybindings() as Parameters<typeof factory>[2],
            (value) => {
              result = value;
            },
          );
          component.handleInput?.("\u001b");
          component.dispose?.();
          return result;
        },
      },
    } as unknown as ExtensionToolContext;
    const response = await tool.execute(
      "id",
      questions,
      undefined,
      undefined,
      ctx,
    );
    assert.equal(response.details.cancelled, true);
    assert.deepEqual(
      events.map((event) => event.name),
      [
        ASK_USER_QUESTION_START,
        DOCKED_PANEL_OPENED,
        DOCKED_PANEL_CLOSED,
        ASK_USER_QUESTION_END,
      ],
    );
    assert.deepEqual(events[1], {
      name: DOCKED_PANEL_OPENED,
      data: { panelId: "ask-user-question", instanceId: "id" },
    });
    assert.deepEqual(events[2], {
      name: DOCKED_PANEL_CLOSED,
      data: {
        panelId: "ask-user-question",
        instanceId: "id",
        status: "cancelled",
      },
    });
    if (enabled) {
      assert.ok(notifications[0]?.includes("Waiting for your answer."));
    }
  });
}

test("RPC questions emit hooks without desktop notifications", async (t) => {
  const { tool, events } = capture(t);
  assert.ok(tool);
  const notifications = interceptNotifications(t);
  await tool.execute(
    "id",
    questions,
    undefined,
    undefined,
    rpcContext(async () => "1. A"),
  );
  assert.equal(events.length, 2);
  assert.deepEqual(notifications, []);
});

for (const outcome of [
  "answered",
  "aborted",
  "error",
  "unopened",
  "factory-gap-abort",
] as const) {
  test(`TUI UI hooks remain distinct from tool hooks (${outcome})`, async (t) => {
    const { tool, events } = capture(t, {
      workflow: { notify: { enabled: false } },
    });
    assert.ok(tool);
    const controller = new AbortController();
    const failure = new Error("host failure");
    let disposals = 0;
    const ctx = {
      hasUI: true,
      mode: "tui",
      ui: {
        async custom(factory: Parameters<ExtensionUIContext["custom"]>[0]) {
          if (outcome === "unopened") throw failure;
          if (outcome === "factory-gap-abort") controller.abort();
          let result: unknown;
          const component = await factory(
            { terminal: { rows: 24 }, requestRender() {} } as unknown as TUI,
            { fg: (_color: string, text: string) => text } as Theme,
            getKeybindings() as Parameters<typeof factory>[2],
            (value) => {
              result = value;
            },
          );
          const dispose = component.dispose?.bind(component);
          component.dispose = () => {
            disposals++;
            dispose?.();
          };
          if (outcome === "error") throw failure;
          if (outcome === "aborted") controller.abort();
          if (outcome === "answered") {
            component.handleInput?.("\r");
            component.handleInput?.("\r");
          }
          return result;
        },
      },
    } as unknown as ExtensionToolContext;
    const call = tool.execute(
      "instance",
      questions,
      controller.signal,
      undefined,
      ctx,
    );
    if (outcome === "answered")
      assert.equal((await call).details.cancelled, false);
    else
      await assert.rejects(
        call,
        outcome.includes("abort") ? { name: "AbortError" } : failure,
      );
    const opened = outcome !== "unopened" && outcome !== "factory-gap-abort";
    assert.deepEqual(
      events.map((event) => event.name),
      opened
        ? [
            ASK_USER_QUESTION_START,
            DOCKED_PANEL_OPENED,
            DOCKED_PANEL_CLOSED,
            ASK_USER_QUESTION_END,
          ]
        : [ASK_USER_QUESTION_START, ASK_USER_QUESTION_END],
    );
    if (opened) {
      assert.equal(disposals, 1);
      assert.deepEqual(events[2].data, {
        panelId: "ask-user-question",
        instanceId: "instance",
        status: outcome === "answered" ? "completed" : outcome,
      });
    }
  });
}
