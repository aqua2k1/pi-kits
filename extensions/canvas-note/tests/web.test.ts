import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

// Evaluate only the helper block: it must not require DOM, sockets, timers or runtime state.
const source = readFileSync(
  new URL("../web/client.js", import.meta.url),
  "utf8",
);
const boundary = source.indexOf("\n  (() => {");
assert.ok(boundary > 0);
const sandbox: { helpers?: Record<string, (...args: unknown[]) => unknown> } =
  {};
runInNewContext(
  `${source.slice(0, boundary)}\n globalThis.helpers = {blockSummary, documentPresentation, tableCellText, selectedReply, replySignature, replyMessage, websocketUrl, parseMessage, controlState, blockPresentation, errorPresentation, replyFailureText, reconnectDelay};\n}`,
  sandbox,
);
const helpers = sandbox.helpers;
assert.ok(helpers);
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));

test("document identity is displayed verbatim without changing the directory name", () => {
  const id = "2026-10-25T04-21-14Z-242c9095-f0b3-45c6-ac79-7bd18a3a90b5";
  assert.deepEqual(plain(helpers.documentPresentation(id)), {
    identity: id,
    title: `Canvas Note: ${id}`,
  });
  for (const value of [undefined, null, 123, ""]) {
    assert.deepEqual(plain(helpers.documentPresentation(value)), {
      identity: "",
      title: "Canvas Note",
    });
  }
  const html = readFileSync(
    new URL("../web/client.html", import.meta.url),
    "utf8",
  );
  assert.match(html, /id="document-id"/);
  assert.ok(
    source.includes('$("document-id").textContent = presentation.identity'),
  );
});

test("browser selection and wire-message helpers preserve input state", () => {
  const block = {
    id: "b",
    type: "text",
    spec: { md: "## Summary\n**Hello**" },
  };
  const selection = new Set(["b"]);
  const records = new Map([["b", { block, pageTitle: "Report" }]]);
  const before = JSON.stringify(block);
  const selected = helpers.selectedReply(4, selection, records) as {
    context: { version: number; blockIds: string[] };
    summaries: string[];
  };
  assert.deepEqual(plain(selected.context), { version: 4, blockIds: ["b"] });
  assert.match(selected.summaries[0], /Report · text/);
  const message = helpers.replyMessage("r", selected.context, "Fix");
  assert.deepEqual(plain(message), {
    type: "reply",
    requestId: "r",
    version: 4,
    blockIds: ["b"],
    reply: "Fix",
  });
  assert.equal(
    helpers.replySignature(selected.context, "Fix"),
    JSON.stringify({ ...selected.context, reply: "Fix" }),
  );
  assert.equal(JSON.stringify(block), before);
  assert.deepEqual([...selection], ["b"]);
  assert.equal(records.get("b")?.block, block);
});

test("browser controls, rendering metadata and transport formatting are deterministic", () => {
  const state = {
    count: 1,
    connected: true,
    closing: false,
    pending: null,
    replyContext: { version: 1 },
    version: 2,
  };
  const before = JSON.stringify(state);
  const controls = helpers.controlState(state) as {
    submitDisabled: boolean;
    staleWarning: boolean;
    selectionLabel: string;
  };
  assert.equal(controls.submitDisabled, true);
  assert.equal(controls.staleWarning, true);
  assert.equal(controls.selectionLabel, "1 selected");
  assert.equal(JSON.stringify(state), before);
  assert.equal(
    (
      helpers.blockPresentation({
        id: "b",
        type: "math",
        spec: { latex: "x" },
      }) as { align: string }
    ).align,
    "left",
  );
  assert.equal(
    helpers.websocketUrl("https:", "example.com"),
    "wss://example.com/ws",
  );
  assert.deepEqual(plain(helpers.parseMessage("bad")), { parsed: false });
  assert.equal(helpers.tableCellText({ x: 1 }), '{"x":1}');
  assert.equal(helpers.reconnectDelay(0), 750);
  assert.equal(helpers.reconnectDelay(100), 30000);
  assert.match(String(helpers.replyFailureText("failed")), /failed/);
});
