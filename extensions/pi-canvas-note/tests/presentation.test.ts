import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  formatDocumentId,
  renderFailureMessage,
  savedBlocksFailure,
  savedDocumentId,
  sshAddressWarning,
  statusText,
  toolResult,
} from "../core/presentation.ts";

test("document identity projection is deterministic and rejects old or invalid identities", () => {
  const uuid = "12345678-1234-1234-1234-123456789abc";
  const date = new Date("2026-10-24T18:30:00.123Z");
  const id = formatDocumentId(date, uuid);
  assert.equal(id, `2026-10-24T18-30-00Z-${uuid}`);
  const entries = [
    { type: "custom", customType: "canvas-note-document", data: { id } },
  ] as ReturnType<ExtensionContext["sessionManager"]["getBranch"]>;
  const before = JSON.stringify(entries);
  assert.equal(savedDocumentId(entries), id);
  assert.equal(savedDocumentId([]), undefined);
  assert.equal(
    savedDocumentId([{ ...entries[0], data: { id: uuid } }] as typeof entries),
    undefined,
  );
  assert.equal(JSON.stringify(entries), before);
  assert.equal(date.toISOString(), "2026-10-24T18:30:00.123Z");
});

test("message builders preserve structured payloads and produce text without effects", () => {
  const result = { pageId: "p", documentPath: "doc.json", version: 1 };
  const response = toolResult("Page inserted.", result);
  assert.deepEqual(response.content, [
    { type: "text", text: "Page inserted." },
  ]);
  assert.equal(response.details, result);
  assert.equal(response.structuredContent, result);
  const error = { version: 1, blockId: "b", message: "Invalid formula" };
  const message = renderFailureMessage(error);
  assert.match(message.content, /Invalid formula/);
  assert.match(message.content, /"blockId":"b"/);
  assert.match(
    savedBlocksFailure(["b"], "doc.json", "bind failed"),
    /Do not insert again/,
  );
  assert.equal(statusText(undefined), undefined);
  assert.equal(
    statusText("http://localhost:1234"),
    "Canvas Note: http://localhost:1234",
  );
  assert.equal(sshAddressWarning(false, undefined), undefined);
  assert.equal(sshAddressWarning(true, "host.example"), undefined);
  assert.match(sshAddressWarning(true, " ") ?? "", /CANVAS_NOTE_PUBLIC_HOST/);
});
