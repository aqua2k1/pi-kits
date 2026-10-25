import assert from "node:assert/strict";
import { test } from "node:test";
import type { Document } from "../core/model.ts";
import {
  errorMessage,
  feedbackForDocument,
  parseClientMessage,
  parseReply,
  renderErrorForDocument,
  replyFingerprint,
} from "../server/protocol.ts";

const doc: Document = {
  version: 4,
  pages: [
    {
      id: "p",
      title: "Report",
      blocks: [
        { id: "b", type: "text", align: "left", spec: { md: "Original" } },
      ],
    },
  ],
};
const input = {
  type: "reply",
  requestId: "r",
  version: 4,
  blockIds: ["b"],
  reply: "Fix this",
};

test("protocol parsing, fingerprint and feedback projection preserve source values", () => {
  const before = JSON.stringify({ input, doc });
  const parsed = parseReply(parseClientMessage(JSON.stringify(input)));
  assert.equal(
    replyFingerprint(parsed),
    JSON.stringify([4, ["b"], "Fix this"]),
  );
  const feedback = feedbackForDocument(parsed, doc);
  assert.equal(feedback.blocks[0].block, doc.pages[0].blocks[0]);
  assert.equal(feedback.blocks[0].pageTitle, "Report");
  assert.equal(feedback.requestId, "r");
  assert.deepEqual(feedbackForDocument(parsed, doc), feedback);
  assert.equal(JSON.stringify({ input, doc }), before);
});

test("protocol validators reject malformed, stale and unknown block references", () => {
  assert.throws(() => parseClientMessage("bad JSON"));
  assert.throws(() => parseClientMessage("null"), /Invalid message/);
  for (const patch of [
    { requestId: "" },
    { blockIds: [] },
    { blockIds: ["b", "b"] },
    { blockIds: [1] },
    { reply: "  " },
    { version: 1.5 },
    { type: "other" },
  ])
    assert.throws(() => parseReply({ ...input, ...patch }), /Invalid reply/);
  const parsed = parseReply(input);
  assert.throws(
    () => feedbackForDocument({ ...parsed, version: 3 }, doc),
    /内容已更新/,
  );
  assert.throws(
    () => feedbackForDocument({ ...parsed, blockIds: ["missing"] }, doc),
    /Unknown blockId/,
  );
});

test("render error projection validates ownership and bounds the message without mutation", () => {
  const error = { version: 4, blockId: "b", message: "x".repeat(2500) };
  const result = renderErrorForDocument(error, doc);
  assert.equal(result?.key, "4:b");
  assert.equal(result?.error.message.length, 2000);
  assert.equal(error.message.length, 2500);
  assert.equal(
    renderErrorForDocument({ ...error, version: 3 }, doc),
    undefined,
  );
  assert.equal(
    renderErrorForDocument({ ...error, blockId: "missing" }, doc),
    undefined,
  );
  assert.equal(errorMessage(new Error("test")), "test");
  assert.equal(errorMessage("test"), "test");
});
