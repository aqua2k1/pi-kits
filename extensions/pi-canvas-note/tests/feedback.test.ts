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
    sendUserMessage: (message: string, options: unknown) => {
      assert.ok(
        entries.some((entry) => entry.customType === "canvas-note-feedback"),
      );
      assert.deepEqual(options, {
        deliverAs: "followUp",
        expandPromptTemplates: false,
      });
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

test("snapshots persist before dispatch; restored follow-ups contain references only", async (t) => {
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
  assert.equal(handlers.has("before_agent_start"), false);
  await inbox.restore(ctx());
  assert.equal(sent.length, 1, "already queued feedback is not re-enqueued");
  inbox.clear();
  await inbox.restore(ctx());
  assert.equal(sent.length, 2);
  assert.equal(sent[1], sent[0]);
  assertCompact(sent[1]);
  assert.equal(
    entries.length,
    1,
    "enqueueing must not mark feedback delivered",
  );
  handlers.get("message_end")?.({
    message: { role: "user", content: sent[1] },
  });

  inbox.clear();
  await inbox.restore(ctx());
  await inbox.accept(reply, documentPath);
  assert.equal(
    sent.length,
    2,
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

    assert.equal(entries.length, 1);
    const content =
      mode === "string"
        ? sent[0]
        : sent[0].split("\n").map((text) => ({ type: "text", text }));
    handlers.get("message_end")?.({ message: { role: "user", content } });

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

test("rejected delivery is restored through a compact follow-up", async (t) => {
  const documentPath = await fixture(t);
  const { pi, ctx, sent } = harness();
  const send = pi.sendUserMessage;
  pi.sendUserMessage = () => {
    throw new Error("inference unavailable");
  };
  const inbox = createFeedbackInbox(pi);
  await assert.rejects(
    inbox.accept(reply, documentPath),
    /inference unavailable/,
  );
  inbox.clear();
  pi.sendUserMessage = send;
  await inbox.restore(ctx());
  assert.equal(sent.length, 1);
  assertCompact(sent[0]);
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

for (const mixed of [false, true]) {
  test(`selected pages persist and recover with compact independent scopes (mixed=${mixed})`, async (t) => {
    const documentPath = await fixture(t);
    const { entries, handlers, sent, pi, ctx } = harness();
    const feedback: Feedback = {
      ...reply,
      blocks: mixed ? reply.blocks : [],
      pageIds: ["p"],
      pages: [
        {
          id: "p",
          title: "Selected page",
          blocks: [
            {
              id: "b",
              type: "text",
              align: "left",
              spec: { md: "Full page content" },
            },
            {
              id: "unselected-block",
              type: "text",
              align: "left",
              spec: { md: "Also captured" },
            },
          ],
        },
      ],
    };
    const inbox = createFeedbackInbox(pi);
    await Promise.all([
      inbox.accept(feedback, documentPath),
      inbox.accept(feedback, documentPath),
    ]);
    assert.equal(sent.length, 1);
    const reference = entries[0].data as {
      snapshotPath: string;
      pageIds: string[];
      blockIds: string[];
    };
    assert.deepEqual(reference.pageIds, ["p"]);
    assert.deepEqual(reference.blockIds, mixed ? ["b"] : []);
    const saved = JSON.parse(await readFile(reference.snapshotPath, "utf8"));
    assert.deepEqual(saved, feedback);
    assert.ok(saved.pages);
    assert.equal(saved.pages[0].blocks.length, 2);
    assert.match(sent[0], /"pageIds":\["p"\]/);
    assert.equal(sent[0].includes("Full page content"), false);
    assert.equal(sent[0].includes("Also captured"), false);
    inbox.clear();
    await inbox.restore(ctx());
    assert.equal(sent.length, 2);
    assert.ok(sent[1].includes('"pageIds":["p"]'));
    assert.equal(sent[1].includes("Full page content"), false);
    await inbox.accept(feedback, documentPath);
    assert.equal(sent.length, 2, "restored page feedback is deduplicated");
    handlers.get("message_end")?.({
      message: { role: "user", content: sent[0] },
    });
    inbox.clear();
    await inbox.restore(ctx());
    assert.equal(sent.length, 2, "delivered page feedback is not re-enqueued");
    assert.deepEqual(
      JSON.parse(await readFile(reference.snapshotPath, "utf8")),
      saved,
    );
    await assert.rejects(
      createFeedbackInbox(harness().pi).accept(
        { ...feedback, pageIds: [], pages: [] },
        documentPath,
      ),
      /Conflicting feedback/,
    );
  });
}

test("legacy compact references default pageIds and recognize delivered legacy prompts", async (t) => {
  const documentPath = await fixture(t);
  const { entries, sent, handlers, pi, ctx } = harness();
  const inbox = createFeedbackInbox(pi);
  await inbox.accept(reply, documentPath);
  const reference = entries[0].data as { pageIds?: string[] };
  delete reference.pageIds;
  const legacyPrompt = sent[0].replace(',"pageIds":[]', "");
  inbox.clear();
  await inbox.restore(ctx());
  assert.equal(sent.length, 2);
  assert.ok(sent[1].includes('"pageIds":[]'));
  handlers.get("message_end")?.({
    message: { role: "user", content: legacyPrompt },
  });
  inbox.clear();
  await inbox.restore(ctx());
  assert.equal(sent.length, 2, "legacy delivery prevents further replay");
});

test("legacy pending snapshots migrate to files and compact session references", async (t) => {
  const cwd = dirname(await fixture(t));
  const id = "2026-01-01T00-00-00Z-00000000-0000-0000-0000-000000000000";
  const { entries, sent, pi, ctx } = harness();
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
  assert.equal(sent.length, 1);
  assertCompact(sent[0]);
  const length = entries.length;
  await inbox.restore(ctx(cwd));
  assert.equal(
    entries.length,
    length,
    "already migrated references need no further writes",
  );
  assert.equal(
    sent.length,
    1,
    "repeated restore does not duplicate follow-ups",
  );
});

test("multiple pending replies stay separate follow-ups and reload preserves the queue", async (t) => {
  const documentPath = await fixture(t);
  const { pi, ctx, sent, handlers } = harness();
  const inbox = createFeedbackInbox(pi);
  await inbox.accept(reply, documentPath);
  await inbox.accept({ ...reply, requestId: "second-reply" }, documentPath);
  assert.equal(sent.length, 2);
  assert.equal(handlers.has("before_agent_start"), false);
  inbox.clear();
  await inbox.restore(ctx(), false);
  await inbox.restore(ctx());
  assert.equal(
    sent.length,
    2,
    "reload does not duplicate Pi's preserved queue",
  );
  inbox.clear();
  await inbox.restore(ctx());
  assert.equal(
    sent.length,
    4,
    "fresh restore re-enqueues each pending reply once",
  );
  assert.deepEqual(sent.slice(2), sent.slice(0, 2));
  await inbox.restore(ctx());
  assert.equal(sent.length, 4);
});
