import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
  reply: "解释图表",
  blocks: [
    {
      pageId: "p",
      pageTitle: "报告",
      block: {
        id: "b",
        type: "chart",
        spec: { secret: "large chart content" },
      },
    },
  ],
};

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const dir = await mkdtemp(join(tmpdir(), "canvas-note-feedback-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return join(dir, "doc.json");
}

function harness() {
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
  const ctx = (cwd = "") =>
    ({
      cwd,
      sessionManager: { getBranch: () => entries },
    }) as unknown as ExtensionContext;
  return { entries, handlers, sent, pi, ctx };
}

function assertCompact(text: string) {
  assert.match(text, /解释图表/);
  assert.match(text, /snapshotPath/);
  assert.match(text, /documentPath/);
  assert.match(text, /"blockIds":\["b"\]/);
  assert.equal(text.includes("large chart content"), false);
  assert.equal(text.includes('"spec"'), false);
}

test("snapshots persist before dispatch; normal and pending messages contain references only", async (t) => {
  const documentPath = await fixture(t);
  const { entries, handlers, sent, pi, ctx } = harness();
  const inbox = createFeedbackInbox(pi);
  await Promise.all([
    inbox.accept(reply, documentPath),
    inbox.accept(reply, documentPath),
  ]);
  assert.equal(sent.length, 1);
  assert.equal(entries.length, 1);
  const path = join(dirname(documentPath), "feedback-reply-test.json");
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), reply);
  assertCompact(sent[0]);
  assert.equal(JSON.stringify(entries).includes("large chart content"), false);
  assert.equal(
    handlers.get("before_agent_start")?.({ prompt: sent[0] }),
    undefined,
  );
  const context = handlers.get("before_agent_start")?.({ prompt: "继续" }) as {
    message: { content: string; details: { ids: string[] } };
  };
  assertCompact(context.message.content);
  assert.deepEqual(context.message.details.ids, [reply.requestId]);
  assert.deepEqual(
    handlers.get("before_agent_start")?.({ prompt: "继续" }),
    context,
  );
  assert.equal(
    entries.length,
    1,
    "projecting pending context must not mark it delivered",
  );
  inbox.clear();
  await inbox.restore(ctx());
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
  await inbox.restore(ctx());
  await inbox.accept(reply, documentPath);
  assert.equal(
    sent.length,
    1,
    "delivered feedback remains deduplicated after reload",
  );
  assert.deepEqual(
    JSON.parse(await readFile(path, "utf8")),
    reply,
    "delivery and clearing runtime state must retain the snapshot",
  );
});

for (const mode of ["string", "text blocks"] as const) {
  test(`delivered feedback matches ${mode} without consuming unrelated messages`, async (t) => {
    const documentPath = await fixture(t);
    const { entries, handlers, sent, pi } = harness();
    await createFeedbackInbox(pi).accept(reply, documentPath);
    handlers.get("message_end")?.({
      message: { role: "user", content: "Unrelated" },
    });
    assert.ok(handlers.get("before_agent_start")?.({ prompt: "Continue" }));
    assert.equal(entries.length, 1);
    const content =
      mode === "string"
        ? sent[0]
        : sent[0].split("\n").map((text) => ({ type: "text", text }));
    handlers.get("message_end")?.({ message: { role: "user", content } });
    assert.equal(
      handlers.get("before_agent_start")?.({ prompt: "Continue" }),
      undefined,
    );
    assert.deepEqual(
      entries.map((entry) => entry.customType),
      ["canvas-note-feedback", "canvas-note-feedback-delivered"],
    );
  });
}

test("snapshot persistence failure prevents session acceptance and dispatch", async (t) => {
  const documentPath = await fixture(t);
  const invalidDocumentPath = join(
    dirname(documentPath),
    "not-a-directory",
    "doc.json",
  );
  await writeFile(dirname(invalidDocumentPath), "not a directory");
  const { entries, sent, pi } = harness();
  await assert.rejects(
    createFeedbackInbox(pi).accept(reply, invalidDocumentPath),
  );
  assert.equal(entries.length, 0);
  assert.equal(sent.length, 0);
});

test("session persistence failure leaves a reusable snapshot without accepting feedback", async (t) => {
  const documentPath = await fixture(t);
  const { pi, sent } = harness();
  const append = pi.appendEntry;
  pi.appendEntry = () => {
    throw new Error("disk full");
  };
  const inbox = createFeedbackInbox(pi);
  await assert.rejects(inbox.accept(reply, documentPath), /disk full/);
  assert.equal(sent.length, 0);
  pi.appendEntry = append;
  await inbox.accept(reply, documentPath);
  assert.equal(sent.length, 1);
});

test("rejected prompt delivery remains recoverable via compact pending context", async (t) => {
  const documentPath = await fixture(t);
  const { pi, ctx, handlers } = harness();
  pi.sendUserMessage = () => {
    throw new Error("inference unavailable");
  };
  const inbox = createFeedbackInbox(pi);
  await assert.rejects(
    inbox.accept(reply, documentPath),
    /inference unavailable/,
  );
  inbox.clear();
  await inbox.restore(ctx());
  const result = handlers.get("before_agent_start")?.({
    prompt: "continue",
  }) as { message: { content: string } };
  assertCompact(result.message.content);
});

test("unsafe request IDs stay beside the document and do not overwrite conflicting snapshots", async (t) => {
  const documentPath = await fixture(t);
  const feedback = { ...reply, requestId: "../../outside" };
  await createFeedbackInbox(harness().pi).accept(feedback, documentPath);
  const files = await readdir(dirname(documentPath));
  assert.equal(files.length, 1);
  assert.match(files[0], /^feedback-[a-f0-9]{64}\.json$/);
  await assert.rejects(
    createFeedbackInbox(harness().pi).accept(
      { ...feedback, reply: "different" },
      documentPath,
    ),
    /Conflicting feedback/,
  );
  assert.deepEqual(
    JSON.parse(await readFile(join(dirname(documentPath), files[0]), "utf8")),
    feedback,
  );
});

test("legacy pending snapshots migrate to files and compact session references", async (t) => {
  const cwd = dirname(await fixture(t));
  const id = "2026-01-01T00-00-00Z-00000000-0000-0000-0000-000000000000";
  const { entries, handlers, pi, ctx } = harness();
  entries.push({
    type: "custom",
    customType: "canvas-note-document",
    data: { id },
  });
  entries.push({
    type: "custom",
    customType: "canvas-note-feedback",
    data: reply,
  });
  const inbox = createFeedbackInbox(pi);
  await inbox.restore(ctx(cwd));
  const reference = entries.at(-1)?.data as { snapshotPath: string };
  assert.deepEqual(
    JSON.parse(await readFile(reference.snapshotPath, "utf8")),
    reply,
  );
  const result = handlers.get("before_agent_start")?.({
    prompt: "continue",
  }) as { message: { content: string } };
  assertCompact(result.message.content);
  const length = entries.length;
  await inbox.restore(ctx(cwd));
  assert.equal(
    entries.length,
    length,
    "already migrated references need no further writes",
  );
});
