import assert from "node:assert/strict";
import { test } from "node:test";
import type { Document } from "../core/model.ts";
import { exportScope, projectExportDocument } from "../web/export-scope.js";
import type { SelectionInput } from "../web/selection-manager.js";

function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}

const block = (id: string) => ({
  id,
  type: "text" as const,
  title: `Block ${id}`,
  align: "left" as const,
  spec: { md: `Content ${id}` },
});
const doc = freeze({
  version: 17,
  metadata: { label: "Preserved document metadata" },
  pages: [
    { id: "p1", title: "First", blocks: [block("a"), block("b")] },
    { id: "empty", title: "Empty", blocks: [] },
    { id: "p2", title: "Second", blocks: [block("c"), block("d")] },
    { id: "p3", title: "Third", blocks: [block("e")] },
  ],
});
const original = structuredClone(doc);

function check(
  selection: SelectionInput,
  expected: [string, string[]][],
  all = false,
) {
  freeze(selection);
  const before = structuredClone(selection);
  const projected: Document = projectExportDocument(doc, selection);
  assert.deepEqual(projected, {
    ...doc,
    pages: expected.map(([id, ids]) => {
      const page = doc.pages.find((candidate) => candidate.id === id);
      assert.ok(page);
      return {
        ...page,
        blocks: page.blocks.filter((candidate) => ids.includes(candidate.id)),
      };
    }),
  });
  assert.deepEqual(
    projected.pages.map((page) => [
      page.id,
      page.blocks.map((item) => item.id),
    ]),
    expected,
  );
  assert.deepEqual(exportScope(doc, selection), {
    all,
    pageIds: expected.map(([id]) => id),
    blockIds: expected.flatMap(([, ids]) => ids),
  });
  assert.deepEqual(doc, original);
  assert.deepEqual(selection, before);
  return projected;
}

test("empty selection exports everything, including empty pages, preserving metadata and content", () => {
  const projected = check(
    { blockIds: [], pageIds: [] },
    [
      ["p1", ["a", "b"]],
      ["empty", []],
      ["p2", ["c", "d"]],
      ["p3", ["e"]],
    ],
    true,
  );
  assert.notEqual(projected, doc);
  assert.notEqual(projected.pages, doc.pages);
  for (let i = 0; i < projected.pages.length; i++) {
    assert.notEqual(projected.pages[i], doc.pages[i]);
    assert.notEqual(projected.pages[i].blocks, doc.pages[i].blocks);
  }
});

test("page-only selection exports full pages in document rather than selection order", () => {
  check({ blockIds: [], pageIds: ["p3", "p1", "p1"] }, [
    ["p1", ["a", "b"]],
    ["p3", ["e"]],
  ]);
});

test("block-only selection exports partial containing pages in original block order", () => {
  check({ blockIds: ["d", "b", "c", "b"], pageIds: [] }, [
    ["p1", ["b"]],
    ["p2", ["c", "d"]],
  ]);
});

test("mixed overlapping selection is a deduplicated union in document order", () => {
  check({ blockIds: ["e", "b", "d", "a", "b"], pageIds: ["p2", "p1", "p2"] }, [
    ["p1", ["a", "b"]],
    ["p2", ["c", "d"]],
    ["p3", ["e"]],
  ]);
});

test("explicit empty pages are retained alone and alongside partial pages", () => {
  check({ blockIds: [], pageIds: ["empty"] }, [["empty", []]]);
  check({ blockIds: ["c"], pageIds: ["empty"] }, [
    ["empty", []],
    ["p2", ["c"]],
  ]);
});

test("stale selections never fall back to all or interfere with live selections", () => {
  check({ blockIds: ["deleted"], pageIds: [] }, []);
  check({ blockIds: [], pageIds: ["deleted"] }, []);
  check({ blockIds: ["deleted"], pageIds: ["deleted"] }, []);
  check({ blockIds: ["deleted", "b"], pageIds: ["deleted", "empty"] }, [
    ["p1", ["b"]],
    ["empty", []],
  ]);
});

test("page and block IDs are interpreted only in their respective scopes", () => {
  check({ blockIds: ["p1"], pageIds: ["a"] }, []);
});

test("empty documents distinguish all from stale scopes", () => {
  const empty: Document = freeze({ version: 2, pages: [] });
  for (const selection of [
    freeze({ blockIds: [], pageIds: [] }),
    freeze({ blockIds: ["missing"], pageIds: [] }),
  ]) {
    assert.deepEqual(projectExportDocument(empty, selection), empty);
    assert.deepEqual(exportScope(empty, selection), {
      all: selection.blockIds.length === 0,
      pageIds: [],
      blockIds: [],
    });
  }
});
