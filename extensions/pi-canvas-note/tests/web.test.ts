import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import {
  BlockKind,
  blockDefinitions,
  OperationKind,
  PageChangeKind,
} from "../core/contracts.js";
import { clientPage } from "./fixtures/client-page.ts";
import { clientGlobals, clientScript } from "./fixtures/client-script.ts";

// Evaluate only the helper block: it must not require DOM, sockets, timers or runtime state.
const source = readFileSync(
  new URL("../web/document-view.js", import.meta.url),
  "utf8",
);
const script = clientScript(source);
const boundary = script.indexOf("\n  // Shared local rendering");
assert.ok(boundary > 0);
const sandbox: typeof clientGlobals & {
  helpers?: Record<string, (...args: unknown[]) => unknown>;
  registries?: Record<string, Record<string, Record<string, unknown>>>;
} = { ...clientGlobals };
runInNewContext(
  `${script.slice(0, boundary)}\n globalThis.helpers = {blockSummary, documentPresentation, tableCellText, blockCopyText, selectedReply, replySignature, replyMessage, websocketUrl, parseMessage, controlState, blockPresentation, validOperations, errorPresentation, replyFailureText, reconnectDelay, openMarkdownLinksInNewTabs, exportMenuPosition};\n globalThis.registries = { blocks: blockHandlers, operations: operationHandlers };\n}`,
  sandbox,
);
const helpers = sandbox.helpers;
assert.ok(helpers);
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));

test("export menu follows its trigger and stays inside the viewport", () => {
  assert.deepEqual(
    plain(
      helpers.exportMenuPosition(
        { right: 500, top: 20, bottom: 60 },
        { width: 160, height: 100 },
        { width: 800, height: 600 },
      ),
    ),
    { left: 340, top: 66 },
  );
  assert.deepEqual(
    plain(
      helpers.exportMenuPosition(
        { right: 90, top: 220, bottom: 260 },
        { width: 160, height: 100 },
        { width: 320, height: 300 },
      ),
    ),
    { left: 8, top: 114 },
  );
  assert.deepEqual(
    plain(
      helpers.exportMenuPosition(
        { right: 900, top: 20, bottom: 60 },
        { width: 160, height: 100 },
        { width: 320, height: 300 },
      ),
    ),
    { left: 152, top: 66 },
  );
});

test("browser registries cover shared kinds with complete behaviors", () => {
  const registries = sandbox.registries;
  assert.ok(registries);
  assert.deepEqual(
    Object.keys(registries.blocks).sort(),
    Object.values(BlockKind).sort(),
  );
  assert.deepEqual(
    Object.keys(registries.operations).sort(),
    Object.values(OperationKind).sort(),
  );
  for (const kind of Object.values(BlockKind)) {
    const handler: Record<string, unknown> = registries.blocks[kind];
    assert.equal(handler.validate, blockDefinitions[kind].validate);
    assert.equal(handler.summarize, blockDefinitions[kind].summarize);
    assert.equal(typeof handler.render, "function");
    assert.equal(typeof handler.copyText, "function");
  }
  for (const kind of Object.values(OperationKind)) {
    assert.equal(typeof registries.operations[kind].validate, "function");
    assert.equal(typeof registries.operations[kind].apply, "function");
  }
});

test("block clipboard text preserves complete source and formats structured content", () => {
  for (const [type, spec, expected] of [
    ["text", { md: "# Heading\n**raw**" }, "# Heading\n**raw**"],
    [
      "code",
      { code: "<script>\n  source\n</script>", language: "html" },
      "<script>\n  source\n</script>",
    ],
    ["math", { latex: "\\frac{1}{2}" }, "\\frac{1}{2}"],
    [
      "chart",
      { series: [{ data: [1, 2] }] },
      JSON.stringify({ series: [{ data: [1, 2] }] }, null, 2),
    ],
    [
      "table",
      {
        columns: ["A", "B"],
        rows: [
          [1, null],
          ["a\tb", 'say "hello"'],
        ],
      },
      'A\tB\n1\t\n"a\tb"\t"say ""hello"""',
    ],
    ["divider", {}, "---"],
  ] as const) {
    const block = { type, spec };
    const before = structuredClone(block);
    assert.equal(helpers.blockCopyText(block), expected);
    assert.deepEqual(block, before);
  }
});

test("new kinds without browser handlers fail during registration", () => {
  for (const [name, kinds] of [
    ["BlockKind", BlockKind],
    ["OperationKind", OperationKind],
  ] as const) {
    assert.throws(
      () =>
        runInNewContext(`${script.slice(0, boundary)}\n}`, {
          ...clientGlobals,
          CanvasNoteContracts: {
            ...clientGlobals.CanvasNoteContracts,
            [name]: { ...kinds, New: "unregistered" },
          },
        }),
      /Missing handler: unregistered/,
    );
  }
  assert.throws(
    () => helpers.blockSummary({ type: "unknown", spec: {} }, "Page"),
    /Unknown block type/,
  );
});

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
  const html = clientPage();
  assert.match(
    html,
    /<link rel="icon" href="\/favicon\.svg" type="image\/svg\+xml" \/>/,
  );
  assert.match(html, /id="document-id"/);
  assert.match(html, /<aside id="outline"/);
  assert.match(html, /id="outline-tree"/);
  assert.match(html, /aria-controls="outline-tree"/);
  assert.ok(
    readFileSync(
      new URL("../web/online-controller.js", import.meta.url),
      "utf8",
    ).includes('$("document-id").textContent = presentation.identity'),
  );
});

test("markdown links open in new tabs with a safe opener relationship", () => {
  const attributes: Record<string, string>[] = [{}, {}];
  const root = {
    querySelectorAll(selector: string) {
      assert.equal(selector, "a");
      return attributes.map((values) => ({
        setAttribute(name: string, value: string) {
          values[name] = value;
        },
      }));
    },
  };
  helpers.openMarkdownLinksInNewTabs(root);
  assert.deepEqual(attributes, [
    { target: "_blank", rel: "noopener noreferrer" },
    { target: "_blank", rel: "noopener noreferrer" },
  ]);
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
  const selected = helpers.selectedReply(
    4,
    { blockIds: [...selection], pageIds: [] },
    records,
  ) as {
    context: { version: number; blockIds: string[] };
    summaries: string[];
  };
  assert.deepEqual(plain(selected.context), {
    version: 4,
    blockIds: ["b"],
    pageIds: [],
  });
  assert.match(selected.summaries[0], /Report · text/);
  const message = helpers.replyMessage("r", selected.context, "Fix");
  assert.deepEqual(plain(message), {
    type: "reply",
    requestId: "r",
    version: 4,
    blockIds: ["b"],
    pageIds: [],
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

test("operation preflight validates only referenced IDs without mutating live records", () => {
  const block = { id: "a", type: "text", align: "left", spec: { md: "A" } };
  const page = { id: "p", title: "Page", blocks: [block] };
  const pages = new Map([["p", { page }]]);
  const blocks = new Map([["a", { block, pageId: "p" }]]);
  const before = JSON.stringify(page);
  const created = { id: "next", title: "Next", blocks: [] };
  const inserted = { ...block, id: "b" };
  const operations = [
    { type: "page:create", page: created, index: 1 },
    { type: "blocks:insert", pageId: "next", index: 0, blocks: [inserted] },
    {
      type: "blocks:update",
      blocks: [{ ...inserted, align: "right" }],
      removed: ["a"],
    },
  ];
  assert.equal(helpers.validOperations(operations, pages, blocks), true);
  for (const invalid of [
    [],
    [{ type: "unknown" }],
    [{ type: "page:create", page: { ...created, id: "p" }, index: 1 }],
    [
      {
        type: "blocks:insert",
        pageId: "missing",
        index: 0,
        blocks: [inserted],
      },
    ],
    [{ type: "blocks:insert", pageId: "p", index: 2, blocks: [inserted] }],
    [
      {
        type: "blocks:insert",
        pageId: "p",
        index: 0,
        blocks: [inserted, inserted],
      },
    ],
    [
      {
        type: "blocks:update",
        blocks: [{ ...block, id: "missing" }],
        removed: [],
      },
    ],
    [{ type: "blocks:update", blocks: [block], removed: ["a"] }],
    [{ type: "blocks:update", blocks: [], removed: ["a", "a"] }],
    [...operations, { type: "blocks:update", blocks: [block], removed: [] }],
  ])
    assert.equal(helpers.validOperations(invalid, pages, blocks), false);
  assert.equal(JSON.stringify(page), before);
  assert.equal(pages.size, 1);
  assert.equal(blocks.size, 1);
  assert.equal(blocks.get("a")?.block, block);
});

test("page preflight follows sequential page/block lifetimes without changing inputs", () => {
  const block = { id: "a", type: "text", align: "left", spec: { md: "A" } };
  const page = { id: "p", title: "Page", blocks: [block] };
  const pages = new Map([["p", { page }]]);
  const blocks = new Map([["a", { block, pageId: "p" }]]);
  const rename = {
    type: "page:update",
    pageId: "p",
    change: { kind: PageChangeKind.Rename, title: "Renamed" },
  };
  const remove = {
    type: "page:update",
    pageId: "p",
    change: { kind: PageChangeKind.Delete },
  };
  const create = {
    type: "page:create",
    page: { id: "p", title: "New", blocks: [] },
    index: 0,
  };
  const insert = {
    type: "blocks:insert",
    pageId: "p",
    index: 0,
    blocks: [block],
  };
  const update = { type: "blocks:update", blocks: [block], removed: [] };
  const before = JSON.stringify({ page, block });
  for (const operations of [
    [rename],
    [remove],
    [rename, remove],
    [remove, create, rename, insert, update, remove],
    [
      { type: "blocks:update", blocks: [], removed: ["a"] },
      remove,
      create,
      insert,
    ],
    [remove, { ...create, page: { ...create.page, id: "a" } }],
  ]) {
    const input = JSON.stringify(operations);
    assert.equal(
      helpers.validOperations(operations, pages, blocks),
      true,
      input,
    );
    assert.equal(JSON.stringify(operations), input);
  }
  for (const operations of [
    [{ ...rename, pageId: "missing" }],
    [{ ...remove, pageId: "missing" }],
    ...[
      undefined,
      null,
      42,
      [],
      {},
      { title: "Renamed" },
      { kind: "unknown" },
      { kind: PageChangeKind.Rename },
      ...[undefined, null, 42, "", " \n "].map((title) => ({
        kind: PageChangeKind.Rename,
        title,
      })),
      { kind: PageChangeKind.Rename, title: "Renamed", delete: true },
      { kind: PageChangeKind.Rename, title: "Renamed", extra: true },
      { kind: PageChangeKind.Delete, title: "Renamed" },
      { kind: PageChangeKind.Delete, delete: true },
      { kind: PageChangeKind.Delete, extra: true },
    ].map((change) => [{ ...rename, change }]),
    [{ type: "page:update", pageId: "p", title: "Renamed" }],
    [{ type: "page:delete", pageId: "p" }],
    [remove, rename],
    [remove, remove],
    [remove, insert],
    [remove, update],
    [remove, { type: "blocks:update", blocks: [], removed: ["a"] }],
    [remove, { ...create, index: 1 }],
    [remove, create, update],
    [remove, create, { ...insert, index: 1 }],
    [remove, create, insert, remove, update],
  ]) {
    const input = JSON.stringify(operations);
    assert.equal(
      helpers.validOperations(operations, pages, blocks),
      false,
      input,
    );
    assert.equal(JSON.stringify(operations), input);
  }
  assert.equal(JSON.stringify({ page, block }), before);
  assert.equal(pages.get("p")?.page, page);
  assert.equal(blocks.get("a")?.block, block);
  assert.equal(pages.size, 1);
  assert.equal(blocks.size, 1);
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
