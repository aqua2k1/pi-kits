import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Value } from "typebox/value";
import { Alignment, BlockKind } from "../core/contracts.js";
import {
  Align,
  BlockTitle,
  BlockType,
  type Document,
  type DocumentCommit,
  DocumentStore,
  documentFingerprint,
  validateBlock,
} from "../core/model.ts";

test("TypeBox block and alignment contracts derive from shared enums", () => {
  for (const [schema, kinds] of [
    [BlockType, BlockKind],
    [Align, Alignment],
  ] as const) {
    const values = Object.values(kinds);
    assert.deepEqual(schema.enum, values);
    for (const value of values) assert.ok(Value.Check(schema, value));
    for (const value of ["unknown", "", null, 1, "toString"])
      assert.equal(Value.Check(schema, value), false);
  }
  const block = { type: BlockKind.Text, spec: { md: "Unchanged" } };
  const before = structuredClone(block);
  validateBlock(block);
  assert.deepEqual(block, before);
  assert.throws(() => validateBlock({ type: BlockKind.Text, spec: {} }), {
    message: "text: spec.md must be a string",
  });
  assert.throws(
    // @ts-expect-error Runtime callers must reject unknown kinds too.
    () => validateBlock({ type: "unknown", spec: {} }),
    /Unknown block type:/,
  );
});

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const dir = await mkdtemp(join(tmpdir(), "canvas-note-model-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return new DocumentStore(join(dir, "doc.json"));
}
const text = (md: string) => ({ type: "text" as const, spec: { md } });

test("optional block titles persist, update, clear and validate", async (t) => {
  const store = await fixture(t);
  const inserted = await store.insert({
    blocks: [
      { type: "text", title: "Introduction", spec: { md: "A" } },
      { type: "math", spec: { latex: "x" } },
    ],
  });
  let blocks = (await store.read()).pages[0].blocks;
  assert.equal(blocks[0].title, "Introduction");
  assert.equal(blocks[1].title, undefined);
  assert.ok(Value.Check(BlockTitle, "Introduction"));
  assert.equal(Value.Check(BlockTitle, "  "), false);
  await store.update({
    blocks: [{ blockId: inserted.blockIds[0], title: "Summary" }],
  });
  blocks = (await store.read()).pages[0].blocks;
  assert.equal(blocks[0].title, "Summary");
  await store.update({
    blocks: [{ blockId: inserted.blockIds[0], align: "right" }],
  });
  assert.equal((await store.read()).pages[0].blocks[0].title, "Summary");
  const before = await readFile(store.path, "utf8");
  await assert.rejects(
    store.update({ blocks: [{ blockId: inserted.blockIds[0], title: " " }] }),
    /Invalid update_blocks parameters/,
  );
  assert.equal(await readFile(store.path, "utf8"), before);
  await store.update({
    blocks: [{ blockId: inserted.blockIds[0], title: null }],
  });
  blocks = (await store.read()).pages[0].blocks;
  assert.equal(blocks[0].title, undefined);
  await assert.rejects(
    store.insert({
      blocks: [{ type: "text", title: "  ", spec: { md: "invalid" } }],
    }),
    /Invalid insert_blocks parameters/,
  );
});

test("commits publish atomic operation batches after persistence across stores", async (t) => {
  const store = await fixture(t);
  const commits: DocumentCommit[] = [];
  const persisted: Promise<string>[] = [];
  const unsubscribe = store.subscribe((commit) => {
    commits.push(commit);
    persisted.push(readFile(store.path, "utf8"));
  });
  const other = new DocumentStore(store.path);
  const inserted = await other.insert({ blocks: [text("A"), text("B")] });
  assert.equal(commits.length, 1);
  const first = commits[0];
  assert.equal(first.before, documentFingerprint({ version: 0, pages: [] }));
  assert.equal(first.baseVersion, 0);
  assert.equal(first.doc.version, 1);
  assert.deepEqual(first.operations, [
    {
      type: "page:create",
      page: { ...first.doc.pages[0], blocks: [] },
      index: 0,
    },
    {
      type: "blocks:insert",
      pageId: inserted.pageId,
      index: 0,
      blocks: first.doc.pages[0].blocks,
    },
  ]);
  assert.deepEqual(JSON.parse(await persisted[0]), first.doc);
  await assert.rejects(other.update({ blocks: [{ blockId: "missing" }] }));
  assert.equal(commits.length, 1);
  await other.update({
    blocks: [
      { blockId: inserted.blockIds[0], align: "right" },
      { blockId: inserted.blockIds[1], type: null },
    ],
  });
  assert.deepEqual(commits[1].operations, [
    {
      type: "blocks:update",
      blocks: commits[1].doc.pages[0].blocks,
      removed: [inserted.blockIds[1]],
    },
  ]);
  assert.equal(commits[1].before, documentFingerprint(first.doc));
  await other.newPage({ title: "Next" });
  assert.deepEqual(commits[2].operations, [
    { type: "page:create", page: commits[2].doc.pages[1], index: 1 },
  ]);
  unsubscribe();
  await other.newPage({ title: "Unobserved" });
  assert.equal(commits.length, 3);
  await Promise.all(persisted);
});

test("ordered insert, whole spec replacement, type change and deletion", async (t) => {
  const store = await fixture(t);
  const { pageId } = await store.newPage({ title: "报告" });
  const first = await store.insert({ pageId, blocks: [text("A"), text("C")] });
  await store.insert({ pageId, index: 1, blocks: [text("B")] });
  assert.deepEqual(
    (await store.read()).pages[0].blocks.map((b) => b.spec.md),
    ["A", "B", "C"],
  );
  await store.update({
    blocks: [
      {
        blockId: first.blockIds[0],
        type: "math",
        spec: { latex: "x^2" },
        align: "center",
      },
    ],
  });
  const block = (await store.read()).pages[0].blocks[0];
  assert.equal(block.id, first.blockIds[0]);
  assert.deepEqual(block.spec, { latex: "x^2" });
  assert.equal(block.type, "math");
  assert.equal(block.align, "center");
  await store.update({ blocks: [{ blockId: block.id, type: null }] });
  assert.equal((await store.read()).pages[0].blocks.length, 2);
  assert.equal((await store.read()).version, 5);
});

test("batch validation is atomic and queue recovers from errors", async (t) => {
  const store = await fixture(t);
  const inserted = await store.insert({ blocks: [text("old")] });
  const before = await readFile(store.path, "utf8");
  await assert.rejects(
    store.update({
      blocks: [
        { blockId: inserted.blockIds[0], spec: { md: "changed" } },
        { blockId: "missing", type: null },
      ],
    }),
    /Unknown/,
  );
  assert.equal(await readFile(store.path, "utf8"), before);
  await assert.rejects(
    store.update({ blocks: [{ blockId: inserted.blockIds[0], type: "math" }] }),
    /requires complete spec/,
  );
  await assert.rejects(store.insert({ blocks: [] }), /Invalid/);
  await assert.rejects(
    store.insert({ blocks: [{ type: "math", spec: { latex: 123 } }] }),
    /latex/,
  );
  await store.update({
    blocks: [{ blockId: inserted.blockIds[0], spec: { md: "fixed" } }],
  });
  assert.equal((await store.read()).pages[0].blocks[0].spec.md, "fixed");
});

test("read decodes and validates documents without writing or selecting a page", async (t) => {
  const store = await fixture(t);
  assert.deepEqual(await store.read(), { version: 0, pages: [] });
  await assert.rejects(readFile(store.path), { code: "ENOENT" });

  const valid: Document = {
    version: 7,
    pages: [
      {
        id: "page",
        title: "Saved",
        blocks: [
          { id: "text", type: "text", align: "left", spec: { md: "saved" } },
          { id: "math", type: "math", align: "center", spec: { latex: "x" } },
          {
            id: "table",
            type: "table",
            align: "right",
            spec: { columns: ["A"], rows: [[1]] },
          },
          { id: "chart", type: "chart", align: "left", spec: {} },
          { id: "divider", type: "divider", align: "left", spec: {} },
        ],
      },
    ],
  };
  const cases: [unknown, RegExp][] = [
    [{ ...valid, version: -1 }, /Invalid Canvas Note document/],
    [
      { ...valid, pages: [valid.pages[0], valid.pages[0]] },
      /Duplicate page ID/,
    ],
    [
      {
        ...valid,
        pages: [
          valid.pages[0],
          { id: "other", title: "", blocks: [valid.pages[0].blocks[0]] },
        ],
      },
      /Duplicate block ID/,
    ],
  ];
  for (const [type, spec, error] of [
    ["text", { md: 1 }, /text: spec.md/],
    ["math", { latex: false }, /math: spec.latex/],
    ["table", { columns: [1], rows: [[]] }, /table: spec.columns/],
    ["table", { columns: ["A"], rows: [1] }, /table: spec.columns/],
  ] as const) {
    cases.push([
      {
        ...valid,
        pages: [
          {
            id: "page",
            title: "Saved",
            blocks: [{ id: "block", type, align: "left", spec }],
          },
        ],
      },
      error,
    ]);
  }
  for (const [doc, error] of cases) {
    const source = JSON.stringify(doc);
    await writeFile(store.path, source);
    await assert.rejects(store.read(), error);
    assert.equal(await readFile(store.path, "utf8"), source);
  }
  await writeFile(store.path, "{broken");
  await assert.rejects(store.read(), SyntaxError);
  assert.equal(await readFile(store.path, "utf8"), "{broken");

  const source = JSON.stringify(valid);
  await writeFile(store.path, source);
  assert.deepEqual(await store.read(), valid);
  assert.equal(await readFile(store.path, "utf8"), source);
  const inserted = await store.insert({ blocks: [text("new")] });
  assert.notEqual(inserted.pageId, "page");
  assert.equal((await store.read()).version, 8);
});

test("update plans validate entire batches before applying mixed changes", async (t) => {
  const store = await fixture(t);
  const first = await store.insert({
    blocks: [text("A"), text("B"), text("C")],
  });
  const second = await store.newPage({ title: "Second" });
  const last = await store.insert({ blocks: [text("D")] });
  const [a, b, c] = first.blockIds;
  const [d] = last.blockIds;
  const before = await readFile(store.path, "utf8");

  for (const [blocks, error] of [
    [
      [
        { blockId: a, type: null },
        { blockId: b, spec: { md: "changed" } },
        { blockId: d, type: "table", spec: { columns: [1], rows: [] } },
      ],
      /table: spec.columns/,
    ],
    [
      [
        { blockId: a, type: null },
        { blockId: a, spec: { md: "again" } },
      ],
      new RegExp(`Duplicate update: ${a}`),
    ],
    [
      [{ blockId: "missing" }, { blockId: "missing" }],
      /Unknown blockId: missing/,
    ],
    [[{ blockId: d, type: "math" }], /changing type requires complete spec/],
  ] as const) {
    // The test cases are readonly; the public contract accepts mutable arrays.
    await assert.rejects(store.update({ blocks: [...blocks] }), error);
    assert.equal(await readFile(store.path, "utf8"), before);
  }

  assert.deepEqual(
    await store.update({
      blocks: [
        { blockId: a, type: null, spec: { md: 123 } },
        { blockId: c, align: "right" },
        { blockId: b, type: null },
        { blockId: d, type: "math", spec: { latex: "x" } },
      ],
    }),
    { updated: [c, d], removed: [a, b] },
  );
  const doc = await store.read();
  assert.equal(doc.version, 4);
  assert.deepEqual(doc.pages[0].blocks, [
    { id: c, type: "text", align: "right", spec: { md: "C" } },
  ]);
  assert.equal(doc.pages[1].id, second.pageId);
  assert.deepEqual(doc.pages[1].blocks, [
    { id: d, type: "math", align: "left", spec: { latex: "x" } },
  ]);
  assert.deepEqual(await store.update({ blocks: [{ blockId: c }] }), {
    updated: [c],
    removed: [],
  });
  assert.equal((await store.read()).version, 5);
});

test("parameter failures and explicit inserts preserve the current page", async (t) => {
  const store = await fixture(t);
  await assert.rejects(store.newPage({ title: "  " }), /Invalid page title/);
  await assert.rejects(store.insert({ blocks: [] }), /Invalid insert_blocks/);
  await assert.rejects(store.update({ blocks: [] }), /Invalid update_blocks/);
  await assert.rejects(readFile(store.path), { code: "ENOENT" });

  const first = await store.newPage({ title: "First" });
  const current = await store.newPage({ title: "Current" });
  await store.insert({ pageId: first.pageId, index: 99, blocks: [text("A")] });
  const before = await readFile(store.path, "utf8");
  await assert.rejects(
    store.insert({ pageId: "missing", blocks: [text("B")] }),
    /Unknown pageId: missing/,
  );
  await assert.rejects(
    store.insert({ index: -1, blocks: [text("B")] }),
    /Invalid insert_blocks/,
  );
  await assert.rejects(
    store.insert({ blocks: [text("B"), { type: "math", spec: {} }] }),
    /math: spec.latex/,
  );
  assert.equal(await readFile(store.path, "utf8"), before);
  assert.equal(
    (await store.insert({ blocks: [text("C")] })).pageId,
    current.pageId,
  );
  const other = new DocumentStore(store.path);
  await other.insert({ pageId: first.pageId, blocks: [text("D")] });
  const fresh = await other.insert({ blocks: [text("E")] });
  assert.notEqual(fresh.pageId, first.pageId);
  assert.notEqual(fresh.pageId, current.pageId);
  assert.equal((await store.read()).version, 6);
});

test("concurrent read-modify-write cannot lose blocks, even across store instances", async (t) => {
  const store = await fixture(t);
  const { pageId } = await store.newPage({ title: "Concurrent" });
  const other = new DocumentStore(store.path);
  await Promise.all(
    Array.from({ length: 30 }, (_, i) =>
      (i % 2 ? store : other).insert({ pageId, blocks: [text(String(i))] }),
    ),
  );
  const doc = await store.read();
  assert.equal(doc.pages[0].blocks.length, 30);
  assert.equal(new Set(doc.pages[0].blocks.map((b) => b.id)).size, 30);
  assert.equal(doc.version, 31);
});
