import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type Document,
  insertBlocks,
  insertPage,
  updateBlocks,
  updatePage,
} from "../core/model.ts";

const text = (md: string) => ({ type: "text" as const, spec: { md } });

function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}

test("pure changes compose without I/O, versions or mutations of their inputs", () => {
  const original: Document = freeze({ version: 7, pages: [] });
  const pageParams = freeze({ title: "Report" });
  const page = insertPage(original, pageParams, "p");
  assert.deepEqual(page.result, { pageId: "p" });
  assert.deepEqual(original, { version: 7, pages: [] });
  freeze(page);

  const params = freeze({ blocks: [text("A"), text("B")] });
  const inserted = insertBlocks(page.doc, params, "p", "unused", ["a", "b"]);
  assert.deepEqual(inserted.result, { pageId: "p", blockIds: ["a", "b"] });
  assert.deepEqual(page.doc.pages[0].blocks, []);
  assert.deepEqual(
    inserted.operations.map((operation) => operation.type),
    ["blocks:insert"],
  );
  freeze(inserted);

  const updated = updateBlocks(
    inserted.doc,
    freeze({
      blocks: [
        { blockId: "a", spec: { md: "Revised" } },
        { blockId: "b", type: null },
      ],
    }),
  );
  assert.deepEqual(updated.result, { updated: ["a"], removed: ["b"] });
  assert.equal(inserted.doc.pages[0].blocks.length, 2);
  assert.equal(inserted.doc.pages[0].blocks[0].spec.md, "A");
  freeze(updated);

  const renamed = updatePage(
    updated.doc,
    freeze({ pageId: "p", change: { kind: "rename", title: "Renamed" } }),
  );
  assert.equal(updated.doc.pages[0].title, "Report");
  assert.equal(renamed.doc.pages[0].title, "Renamed");
  freeze(renamed);
  const deleted = updatePage(
    renamed.doc,
    freeze({ pageId: "p", change: { kind: "delete" } }),
  );
  assert.deepEqual(deleted.doc.pages, []);
  assert.equal(renamed.doc.pages.length, 1);
  for (const change of [page, inserted, updated, renamed, deleted])
    assert.equal(change.doc.version, 7);
  assert.deepEqual(insertPage(original, pageParams, "p"), page);
});

test("implicit insertion generates page and block operations using explicit IDs", () => {
  const doc: Document = freeze({ version: 0, pages: [] });
  const result = insertBlocks(doc, { blocks: [text("A")] }, undefined, "p", [
    "a",
  ]);
  assert.equal(result.doc.pages[0].title, "输出");
  assert.deepEqual(result.operations, [
    {
      type: "page:create",
      page: { id: "p", title: "输出", blocks: [] },
      index: 0,
    },
    {
      type: "blocks:insert",
      pageId: "p",
      index: 0,
      blocks: result.doc.pages[0].blocks,
    },
  ]);
  assert.deepEqual(doc.pages, []);
});

test("pure changes reject invalid batches without changing caller state", () => {
  const doc: Document = freeze({
    version: 2,
    pages: [
      {
        id: "p",
        title: "Report",
        blocks: [{ id: "a", type: "text", align: "left", spec: { md: "A" } }],
      },
    ],
  });
  const before = structuredClone(doc);
  assert.throws(
    () =>
      updateBlocks(doc, {
        blocks: [
          { blockId: "a", spec: { md: "Must not apply" } },
          { blockId: "missing", type: null },
        ],
      }),
    /Unknown blockId/,
  );
  assert.throws(
    () =>
      updatePage(doc, {
        pageId: "p",
        change: { kind: "rename", title: "Report" },
      }),
    /unchanged/,
  );
  assert.throws(
    () =>
      insertBlocks(
        doc,
        { pageId: "missing", blocks: [text("A")] },
        undefined,
        "new",
        ["b"],
      ),
    /Unknown pageId/,
  );
  assert.deepEqual(doc, before);
});
