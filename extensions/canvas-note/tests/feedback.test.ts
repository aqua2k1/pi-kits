import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { createFeedbackInbox } from "../core/feedback.ts";
import type { Feedback } from "../core/types.ts";

const reply: Feedback = {
  requestId: "reply-test",
  version: 1,
  reply: "修正图表",
  blocks: [
    {
      pageId: "p",
      pageTitle: "报告",
      block: { id: "b", type: "chart", spec: {} },
    },
  ],
};

test("accepted replies are persisted before dispatch and recover when prompt delivery fails", () => {
  const entries: { type: string; customType: string; data: unknown }[] = [];
  const handlers = new Map<string, (event: unknown) => unknown>();
  const sent: string[] = [];
  const pi = {
    on: (name: string, handler: (event: unknown) => unknown) =>
      handlers.set(name, handler),
    appendEntry: (customType: string, data: unknown) =>
      entries.push({ type: "custom", customType, data }),
    sendUserMessage: (message: string) => {
      assert.equal(entries.at(-1)?.customType, "canvas-note-feedback");
      sent.push(message);
    },
  } as unknown as ExtensionAPI;
  const inbox = createFeedbackInbox(pi);
  inbox.accept(reply);
  inbox.accept(reply);
  assert.equal(sent.length, 1);
  assert.equal(entries.length, 1);
  assert.equal(
    handlers.get("before_agent_start")?.({ prompt: sent[0] }),
    undefined,
    "the same reply must not also be injected as custom context",
  );
  const context = handlers.get("before_agent_start")?.({ prompt: "继续" }) as {
    message: { content: string; details: { ids: string[] } };
  };
  assert.match(context.message.content, /修正图表/);
  assert.deepEqual(context.message.details.ids, [reply.requestId]);
  assert.deepEqual(
    handlers.get("before_agent_start")?.({ prompt: "继续" }),
    context,
  );
  assert.equal(
    entries.length,
    1,
    "building pending context must not mark feedback delivered",
  );
  inbox.clear();
  inbox.restore({
    sessionManager: { getBranch: () => entries },
  } as unknown as ExtensionContext);
  assert.ok(handlers.get("before_agent_start")?.({ prompt: "继续" }));
  handlers.get("message_end")?.({
    message: {
      role: "custom",
      customType: "canvas-note-feedback-pending",
      details: { ids: [reply.requestId] },
    },
  });
  assert.equal(
    handlers.get("before_agent_start")?.({ prompt: "继续" }),
    undefined,
  );
  inbox.clear();
  inbox.restore({
    sessionManager: { getBranch: () => entries },
  } as unknown as ExtensionContext);
  inbox.accept(reply);
  assert.equal(
    sent.length,
    1,
    "a delivered request stays deduplicated after reload",
  );
});

for (const mode of ["string", "text blocks"] as const) {
  test(`delivered user feedback matches ${mode} content without consuming unrelated messages`, () => {
    const handlers = new Map<string, (event: unknown) => unknown>();
    const entries: string[] = [];
    let sent = "";
    const pi = {
      on: (name: string, handler: (event: unknown) => unknown) =>
        handlers.set(name, handler),
      appendEntry: (type: string) => entries.push(type),
      sendUserMessage: (text: string) => {
        sent = text;
      },
    } as unknown as ExtensionAPI;
    createFeedbackInbox(pi).accept(reply);
    handlers.get("message_end")?.({
      message: { role: "user", content: "Unrelated" },
    });
    assert.ok(handlers.get("before_agent_start")?.({ prompt: "Continue" }));
    assert.equal(entries.length, 1);
    const content =
      mode === "string"
        ? sent
        : sent.split("\n").map((text) => ({ type: "text", text }));
    handlers.get("message_end")?.({ message: { role: "user", content } });
    assert.equal(
      handlers.get("before_agent_start")?.({ prompt: "Continue" }),
      undefined,
    );
    assert.deepEqual(entries, [
      "canvas-note-feedback",
      "canvas-note-feedback-delivered",
    ]);
  });
}

test("browser acknowledgment cannot succeed if persistence fails", () => {
  let sent = false;
  const pi = {
    on: () => {},
    appendEntry: () => {
      throw new Error("disk full");
    },
    sendUserMessage: () => {
      sent = true;
    },
  } as unknown as ExtensionAPI;
  const inbox = createFeedbackInbox(pi);
  assert.throws(() => inbox.accept(reply), /disk full/);
  assert.equal(sent, false);
});
