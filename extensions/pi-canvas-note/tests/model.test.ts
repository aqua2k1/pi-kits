import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Compile } from "typebox/compile";
import { Value } from "typebox/value";
import { Alignment, BlockKind } from "../core/contracts.js";
import {
  Align,
  BlockTitle,
  BlockType,
  type Document,
  type DocumentCommit,
  documentFingerprint,
  InsertBlock,
  InsertBlocksParams,
  InsertBlocksToolParams,
  UpdateBlocksParams,
  UpdatePageParams,
  validateBlock,
} from "../core/model.ts";
import { DocumentStore } from "../core/store.ts";

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

test("insert schemas constrain specs by kind and preserve open content", () => {
  assert.deepEqual(
    new Set(InsertBlock.anyOf.map((schema) => schema.properties.type.const)),
    new Set(Object.values(BlockKind)),
  );
  const compiled = Compile(InsertBlocksToolParams);
  for (const block of [
    { type: BlockKind.Text, spec: { md: "", extra: true } },
    { type: BlockKind.Math, spec: { latex: "x" } },
    { type: BlockKind.Code, spec: { code: "" } },
    {
      type: BlockKind.Code,
      spec: { code: "const x = 1;", language: "javascript" },
    },
    { type: BlockKind.Code, spec: { code: "plain", language: "" } },
    {
      type: BlockKind.Code,
      spec: { code: "plain", language: "unknown-language", extra: true },
    },
    { type: BlockKind.Table, spec: { columns: ["A"], rows: [[1, null, {}]] } },
    { type: BlockKind.Chart, spec: { arbitrary: true } },
    { type: BlockKind.Divider, spec: { arbitrary: true } },
  ]) {
    assert.ok(Value.Check(InsertBlock, block));
    assert.ok(Value.Check(InsertBlocksToolParams, { blocks: [block] }));
    assert.ok(compiled.Check({ blocks: [block] }));
    assert.ok(
      Value.Check(UpdateBlocksParams, {
        blocks: [{ blockId: "id", spec: block.spec }],
      }),
    );
  }
  for (const block of [
    { type: BlockKind.Text, spec: {} },
    { type: BlockKind.Text, spec: { md: 1 } },
    { type: BlockKind.Math, spec: { latex: false } },
    ...[
      {},
      { code: null },
      { code: 1 },
      { code: false },
      { code: [] },
      { code: {} },
      { code: "x", language: null },
      { code: "x", language: 1 },
      { code: "x", language: false },
      { code: "x", language: [] },
      { code: "x", language: {} },
    ].map((spec) => ({ type: BlockKind.Code, spec })),
    { type: BlockKind.Code, spec: [] },
    { type: BlockKind.Code, spec: null },
    { type: BlockKind.Table, spec: { columns: [1], rows: [] } },
    { type: BlockKind.Table, spec: { columns: [], rows: [1] } },
    { type: "unknown", spec: {} },
    { type: BlockKind.Chart, spec: [] },
  ]) {
    assert.equal(Value.Check(InsertBlock, block), false);
    assert.equal(
      Value.Check(InsertBlocksToolParams, { blocks: [block] }),
      false,
    );
    assert.equal(compiled.Check({ blocks: [block] }), false);
  }
});

test("tool insert schema shares metadata and retains all content shapes", () => {
  const block = InsertBlocksToolParams.properties.blocks.items;
  assert.deepEqual(Object.keys(block.properties), ["title", "align"]);
  assert.deepEqual(
    block.anyOf.map((branch) => branch.properties.type.const),
    InsertBlock.anyOf.map((branch) => branch.properties.type.const),
  );
  assert.deepEqual(block.required, ["type", "spec"]);
  assert.deepEqual(
    block.anyOf,
    InsertBlock.anyOf.map((branch) => ({
      properties: {
        type: branch.properties.type,
        spec: branch.properties.spec,
      },
    })),
  );
  const serialized = JSON.stringify(InsertBlocksToolParams);
  assert.equal(serialized.split("Optional outline label.").length - 1, 1);
  assert.equal(
    serialized.split("Block alignment; defaults to left.").length - 1,
    1,
  );
  assert.ok(serialized.length < 2200, "public schema stays compact");
  assert.ok(
    serialized.length < JSON.stringify(InsertBlocksParams).length * 0.7,
  );
  for (const params of [
    { blocks: [] },
    { index: -1, blocks: [text("A")] },
    { blocks: [{ type: "unknown", spec: {} }] },
    { blocks: [{ type: "text", spec: [] }] },
    { blocks: [{ type: "text", spec: null }] },
    { blocks: [{ type: "text", title: " ", spec: { md: "A" } }] },
    { blocks: [{ type: "text", align: "unknown", spec: { md: "A" } }] },
    { blocks: [{}] },
    { blocks: [{ spec: { md: "A" } }] },
    { blocks: [{ type: "chart" }] },
    { blocks: [{ type: "text", spec: { latex: "x" } }] },
    { blocks: [{ type: "math", spec: { md: "A" } }] },
    { blocks: [{ type: "code", spec: { md: "A" } }] },
    { blocks: [{ type: "table", spec: { code: "A" } }] },
    { blocks: [text("A"), { type: "text", spec: { latex: "x" } }] },
  ]) {
    assert.equal(Value.Check(InsertBlocksToolParams, params), false);
    assert.equal(Compile(InsertBlocksToolParams).Check(params), false);
  }
});

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const dir = await mkdtemp(join(tmpdir(), "canvas-note-model-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return new DocumentStore(join(dir, "doc.json"));
}
const text = (md: string) => ({ type: "text" as const, spec: { md } });

test("page rename and deletion commit atomically and preserve current-page semantics", async (t) => {
  const store = await fixture(t);
  const commits: DocumentCommit[] = [];
  t.after(store.subscribe((commit) => commits.push(commit)));
  const first = await store.insertPage({ title: "First" });
  const inserted = await store.insertBlocks({ blocks: [text("A")] });
  const current = await store.insertPage({ title: "Current" });
  const before = await store.read();
  const renamed = await store.updatePage({
    pageId: first.pageId,
    change: { kind: "rename", title: "Renamed" },
  });
  assert.deepEqual(renamed, { pageId: first.pageId, deleted: false });
  const after = await store.read();
  assert.equal(after.version, before.version + 1);
  assert.deepEqual(after.pages[0], { ...before.pages[0], title: "Renamed" });
  assert.deepEqual(commits.at(-1)?.operations, [
    {
      type: "page:update",
      pageId: first.pageId,
      change: { kind: "rename", title: "Renamed" },
    },
  ]);
  assert.equal(
    (await store.insertBlocks({ blocks: [text("B")] })).pageId,
    current.pageId,
  );
  const params = { pageId: first.pageId, change: { kind: "delete" as const } };
  const original = structuredClone(params);
  assert.deepEqual(await store.updatePage(params), {
    pageId: first.pageId,
    deleted: true,
  });
  assert.deepEqual(params, original);
  assert.deepEqual(commits.at(-1)?.operations, [
    { type: "page:update", pageId: first.pageId, change: { kind: "delete" } },
  ]);
  await assert.rejects(
    store.updateBlocks({
      blocks: [{ blockId: inserted.blockIds[0], type: null }],
    }),
    /Unknown blockId/,
  );
  assert.equal(
    (await store.insertBlocks({ blocks: [text("C")] })).pageId,
    current.pageId,
  );
  await store.updatePage({
    pageId: current.pageId,
    change: { kind: "delete" },
  });
  assert.deepEqual((await store.read()).pages, []);
  assert.deepEqual((await new DocumentStore(store.path).read()).pages, []);
  const next = await store.insertBlocks({ blocks: [text("New")] });
  assert.notEqual(next.pageId, current.pageId);
  assert.equal((await store.read()).pages[0].title, "输出");
});

test("invalid and unchanged page updates do not write or publish", async (t) => {
  const store = await fixture(t);
  const { pageId } = await store.insertPage({ title: "Original" });
  const source = await readFile(store.path, "utf8");
  let publications = 0;
  t.after(store.subscribe(() => publications++));
  for (const params of [
    { pageId, change: { kind: "rename" as const, title: "Original" } },
    {
      pageId: "missing",
      change: { kind: "rename" as const, title: "Changed" },
    },
    { pageId: "missing", change: { kind: "delete" as const } },
  ]) {
    await assert.rejects(store.updatePage(params));
    assert.equal(await readFile(store.path, "utf8"), source);
  }
  for (const params of [
    { pageId },
    { pageId, title: "Old format" },
    { pageId, delete: true },
    { pageId, change: null },
    { pageId, change: {} },
    { pageId, change: { kind: "unknown" } },
    { pageId, change: { kind: "rename" } },
    { pageId, change: { kind: "rename", title: " " } },
    { pageId, change: { kind: "rename", title: null } },
    { pageId, change: { kind: "rename", title: "New", extra: true } },
    { pageId, change: { kind: "delete", title: "New" } },
    { pageId, change: { kind: "delete", extra: true } },
    { change: { kind: "delete" } },
    { pageId, change: { kind: "delete" }, title: "Extra" },
  ]) {
    assert.equal(Value.Check(UpdatePageParams, params), false);
    await assert.rejects(
      // @ts-expect-error Runtime callers can supply malformed JSON.
      store.updatePage(params),
      /Invalid update_page parameters/,
    );
    assert.equal(await readFile(store.path, "utf8"), source);
  }
  assert.equal(publications, 0);
  assert.equal(
    (await store.insertBlocks({ blocks: [text("Still current")] })).pageId,
    pageId,
  );
});

test("optional block titles persist, update, clear and validate", async (t) => {
  const store = await fixture(t);
  const inserted = await store.insertBlocks({
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
  await store.updateBlocks({
    blocks: [{ blockId: inserted.blockIds[0], title: "Summary" }],
  });
  blocks = (await store.read()).pages[0].blocks;
  assert.equal(blocks[0].title, "Summary");
  await store.updateBlocks({
    blocks: [{ blockId: inserted.blockIds[0], align: "right" }],
  });
  assert.equal((await store.read()).pages[0].blocks[0].title, "Summary");
  const before = await readFile(store.path, "utf8");
  await assert.rejects(
    store.updateBlocks({
      blocks: [{ blockId: inserted.blockIds[0], title: " " }],
    }),
    /Invalid update_blocks parameters/,
  );
  assert.equal(await readFile(store.path, "utf8"), before);
  await store.updateBlocks({
    blocks: [{ blockId: inserted.blockIds[0], title: null }],
  });
  blocks = (await store.read()).pages[0].blocks;
  assert.equal(blocks[0].title, undefined);
  await assert.rejects(
    store.insertBlocks({
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
  const inserted = await other.insertBlocks({ blocks: [text("A"), text("B")] });
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
  await assert.rejects(
    other.updateBlocks({ blocks: [{ blockId: "missing" }] }),
  );
  assert.equal(commits.length, 1);
  await other.updateBlocks({
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
  await other.insertPage({ title: "Next" });
  assert.deepEqual(commits[2].operations, [
    { type: "page:create", page: commits[2].doc.pages[1], index: 1 },
  ]);
  unsubscribe();
  await other.insertPage({ title: "Unobserved" });
  assert.equal(commits.length, 3);
  await Promise.all(persisted);
});

test("ordered insert, whole spec replacement, type change and deletion", async (t) => {
  const store = await fixture(t);
  const { pageId } = await store.insertPage({ title: "报告" });
  const first = await store.insertBlocks({
    pageId,
    blocks: [text("A"), text("C")],
  });
  await store.insertBlocks({ pageId, index: 1, blocks: [text("B")] });
  assert.deepEqual(
    (await store.read()).pages[0].blocks.map((b) => b.spec.md),
    ["A", "B", "C"],
  );
  await store.updateBlocks({
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
  await store.updateBlocks({ blocks: [{ blockId: block.id, type: null }] });
  assert.equal((await store.read()).pages[0].blocks.length, 2);
  assert.equal((await store.read()).version, 5);
});

test("code blocks persist, replace specs, change types and delete", async (t) => {
  const store = await fixture(t);
  const inserted = await store.insertBlocks({
    blocks: [
      {
        type: BlockKind.Code,
        title: "Example",
        spec: { code: "const x = 1;", language: "javascript" },
      },
      { type: BlockKind.Code, spec: { code: "", language: "" } },
      {
        type: BlockKind.Code,
        spec: { code: "plain", language: "unknown-language" },
      },
    ],
  });
  const [id] = inserted.blockIds;
  assert.deepEqual(
    (await new DocumentStore(store.path).read()).pages[0].blocks.map(
      (block) => block.spec,
    ),
    [
      { code: "const x = 1;", language: "javascript" },
      { code: "", language: "" },
      { code: "plain", language: "unknown-language" },
    ],
  );
  await store.updateBlocks({ blocks: [{ blockId: id, spec: { code: "" } }] });
  assert.deepEqual((await store.read()).pages[0].blocks[0], {
    id,
    type: BlockKind.Code,
    title: "Example",
    align: "left",
    spec: { code: "" },
  });
  await store.updateBlocks({
    blocks: [
      { blockId: id, type: BlockKind.Text, spec: { md: "Explanation" } },
    ],
  });
  assert.deepEqual((await store.read()).pages[0].blocks[0].spec, {
    md: "Explanation",
  });
  await store.updateBlocks({
    blocks: [
      {
        blockId: id,
        type: BlockKind.Code,
        spec: { code: "print(1)", language: "python" },
      },
    ],
  });
  const block = (await store.read()).pages[0].blocks[0];
  assert.equal(block.id, id);
  assert.equal(block.type, BlockKind.Code);
  assert.deepEqual(block.spec, { code: "print(1)", language: "python" });
  assert.deepEqual(
    await store.updateBlocks({ blocks: [{ blockId: id, type: null }] }),
    {
      updated: [],
      removed: [id],
    },
  );
  assert.deepEqual(
    (await store.read()).pages[0].blocks.map((item) => item.id),
    inserted.blockIds.slice(1),
  );
});

test("invalid code updates and type changes fail atomically without publishing", async (t) => {
  const store = await fixture(t);
  const inserted = await store.insertBlocks({
    blocks: [
      text("unchanged"),
      { type: BlockKind.Code, spec: { code: "old", language: "javascript" } },
    ],
  });
  const [textId, codeId] = inserted.blockIds;
  const commits: DocumentCommit[] = [];
  t.after(store.subscribe((commit) => commits.push(commit)));
  const before = await readFile(store.path, "utf8");
  for (const patch of [
    { blockId: codeId, spec: {} },
    { blockId: codeId, spec: { language: "python" } },
    { blockId: codeId, spec: { code: 1 } },
    { blockId: codeId, spec: { code: "new", language: null } },
    { blockId: textId, type: BlockKind.Code },
    { blockId: textId, type: BlockKind.Code, spec: { md: "wrong spec" } },
  ]) {
    await assert.rejects(
      store.updateBlocks({
        blocks: [
          {
            blockId: patch.blockId === codeId ? textId : codeId,
            align: "right",
          },
          patch,
        ],
      }),
      /code:|requires complete spec/,
    );
    assert.equal(await readFile(store.path, "utf8"), before);
    assert.equal(commits.length, 0);
  }
  await store.updateBlocks({
    blocks: [{ blockId: codeId, spec: { code: "recovered" } }],
  });
  assert.equal(commits.length, 1);
  assert.deepEqual((await store.read()).pages[0].blocks[1].spec, {
    code: "recovered",
  });
});

test("batch validation is atomic and queue recovers from errors", async (t) => {
  const store = await fixture(t);
  const inserted = await store.insertBlocks({ blocks: [text("old")] });
  const before = await readFile(store.path, "utf8");
  await assert.rejects(
    store.updateBlocks({
      blocks: [
        { blockId: inserted.blockIds[0], spec: { md: "changed" } },
        { blockId: "missing", type: null },
      ],
    }),
    /Unknown/,
  );
  assert.equal(await readFile(store.path, "utf8"), before);
  await assert.rejects(
    store.updateBlocks({
      blocks: [{ blockId: inserted.blockIds[0], type: "math" }],
    }),
    /requires complete spec/,
  );
  await assert.rejects(store.insertBlocks({ blocks: [] }), /Invalid/);
  await assert.rejects(
    // @ts-expect-error Runtime input must reject non-string latex.
    store.insertBlocks({ blocks: [{ type: "math", spec: { latex: 123 } }] }),
    /Invalid insert_blocks/,
  );
  await store.updateBlocks({
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
          {
            id: "code",
            type: BlockKind.Code,
            align: "left",
            spec: { code: "", language: "unknown-language" },
          },
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
    [BlockKind.Code, {}, /code:/],
    [BlockKind.Code, { code: false }, /code:/],
    [BlockKind.Code, { code: "x", language: null }, /code:/],
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
  const inserted = await store.insertBlocks({ blocks: [text("new")] });
  assert.notEqual(inserted.pageId, "page");
  assert.equal((await store.read()).version, 8);
});

test("update plans validate entire batches before applying mixed changes", async (t) => {
  const store = await fixture(t);
  const first = await store.insertBlocks({
    blocks: [text("A"), text("B"), text("C")],
  });
  const second = await store.insertPage({ title: "Second" });
  const last = await store.insertBlocks({ blocks: [text("D")] });
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
    await assert.rejects(store.updateBlocks({ blocks: [...blocks] }), error);
    assert.equal(await readFile(store.path, "utf8"), before);
  }

  assert.deepEqual(
    await store.updateBlocks({
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
  assert.deepEqual(await store.updateBlocks({ blocks: [{ blockId: c }] }), {
    updated: [c],
    removed: [],
  });
  assert.equal((await store.read()).version, 5);
});

test("parameter failures and explicit inserts preserve the current page", async (t) => {
  const store = await fixture(t);
  await assert.rejects(store.insertPage({ title: "  " }), /Invalid page title/);
  await assert.rejects(
    store.insertBlocks({ blocks: [] }),
    /Invalid insert_blocks/,
  );
  await assert.rejects(
    store.updateBlocks({ blocks: [] }),
    /Invalid update_blocks/,
  );
  await assert.rejects(readFile(store.path), { code: "ENOENT" });

  const first = await store.insertPage({ title: "First" });
  const current = await store.insertPage({ title: "Current" });
  await store.insertBlocks({
    pageId: first.pageId,
    index: 99,
    blocks: [text("A")],
  });
  const before = await readFile(store.path, "utf8");
  await assert.rejects(
    store.insertBlocks({ pageId: "missing", blocks: [text("B")] }),
    /Unknown pageId: missing/,
  );
  await assert.rejects(
    store.insertBlocks({ index: -1, blocks: [text("B")] }),
    /Invalid insert_blocks/,
  );
  await assert.rejects(
    // @ts-expect-error Runtime input must reject a math block without latex.
    store.insertBlocks({ blocks: [text("B"), { type: "math", spec: {} }] }),
    /Invalid insert_blocks/,
  );
  assert.equal(await readFile(store.path, "utf8"), before);
  assert.equal(
    (await store.insertBlocks({ blocks: [text("C")] })).pageId,
    current.pageId,
  );
  const other = new DocumentStore(store.path);
  await other.insertBlocks({ pageId: first.pageId, blocks: [text("D")] });
  const fresh = await other.insertBlocks({ blocks: [text("E")] });
  assert.notEqual(fresh.pageId, first.pageId);
  assert.notEqual(fresh.pageId, current.pageId);
  assert.equal((await store.read()).version, 6);
});

test("concurrent read-modify-write cannot lose blocks, even across store instances", async (t) => {
  const store = await fixture(t);
  const { pageId } = await store.insertPage({ title: "Concurrent" });
  const other = new DocumentStore(store.path);
  await Promise.all(
    Array.from({ length: 30 }, (_, i) =>
      (i % 2 ? store : other).insertBlocks({
        pageId,
        blocks: [text(String(i))],
      }),
    ),
  );
  const doc = await store.read();
  assert.equal(doc.pages[0].blocks.length, 30);
  assert.equal(new Set(doc.pages[0].blocks.map((b) => b.id)).size, 30);
  assert.equal(doc.version, 31);
});
