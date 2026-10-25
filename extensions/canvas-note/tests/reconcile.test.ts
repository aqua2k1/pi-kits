import assert from "node:assert/strict";
import { test } from "node:test";
import type { Block, Document, Operation, Page } from "../core/model.ts";
import { browser, subtree, writeCount } from "./fixtures/browser.ts";

const text = (id: string, md = id): Block => ({
  id,
  type: "text",
  align: "left",
  spec: { md },
});
const chart = (id: string): Block => ({
  id,
  type: "chart",
  align: "left",
  spec: { series: [{ type: "bar", data: [1, 2] }] },
});
const page = (id: string, blocks: Block[], title = id): Page => ({
  id,
  title,
  blocks,
});
const document = (pages: Page[], version = 1): Document => ({ version, pages });
const initial = () =>
  document([
    page("p1", [text("a"), text("b"), chart("c")]),
    page("p2", [text("d")]),
  ]);
const content = (element: ReturnType<ReturnType<typeof browser>["block"]>) =>
  element.children[1];
const blockOrder = (element: ReturnType<ReturnType<typeof browser>["page"]>) =>
  element.children[1].children.map((block) => block.dataset.blockId);
const outlinePage = (b: ReturnType<typeof browser>, id: string) => {
  const entry = subtree(b.get("outline-list")).find(
    (node) =>
      node.dataset.pageId === id && node.classList.contains("outline-page"),
  );
  assert.ok(entry);
  return entry;
};
const outlineBlockOrder = (b: ReturnType<typeof browser>, id: string) =>
  outlinePage(b, id).children[1].children.map((block) => block.dataset.blockId);

const update = (blocks: Block[], removed: string[] = []): Operation => ({
  type: "blocks:update",
  blocks,
  removed,
});
const select = (b: ReturnType<typeof browser>, id: string) => {
  const checkbox = b.block(id).children[0];
  checkbox.checked = true;
  checkbox.emit("change");
};

test("outline mirrors pages and blocks and supports fixed navigation and collapse", () => {
  const b = browser();
  b.snapshot(initial());
  const outline = b.get("outline-list");
  assert.deepEqual(
    outline.children.map((entry) => entry.dataset.pageId),
    ["p1", "p2"],
  );
  assert.deepEqual(
    subtree(outline)
      .filter((entry) => entry.dataset.blockId)
      .map((entry) => entry.dataset.blockId),
    ["a", "b", "c", "d"],
  );
  const firstBlock = subtree(outline).find(
    (entry) =>
      entry.dataset.blockId === "a" &&
      entry.classList.contains("outline-block"),
  );
  assert.equal(firstBlock?.children[0].textContent, "text");

  const firstPage = outline.children[0];
  const firstPageToggle = subtree(firstPage).find((entry) =>
    entry.classList.contains("outline-page-toggle"),
  );
  assert.ok(firstPageToggle);
  firstPageToggle.emit("click");
  const firstPageChildren = subtree(firstPage).find((entry) =>
    entry.classList.contains("outline-children"),
  );
  assert.equal(firstPageChildren?.hidden, true);
  firstPageToggle.emit("click");
  assert.equal(firstPageChildren?.hidden, false);

  const blockItem = subtree(outline).find(
    (entry) =>
      entry.dataset.blockId === "b" &&
      entry.classList.contains("outline-block"),
  );
  assert.ok(blockItem);
  const blockLink = blockItem.children[0];
  blockLink.emit("click");
  assert.equal(b.block("b").writes.scrollIntoView, 1);
  const pageItem = subtree(outline).find(
    (entry) =>
      entry.dataset.pageId === "p2" && entry.classList.contains("outline-page"),
  );
  assert.ok(pageItem);
  const pageLink = subtree(pageItem).find((entry) =>
    entry.classList.contains("outline-page-link"),
  );
  assert.ok(pageLink);
  pageLink.emit("click");
  assert.equal(b.page("p2").writes.scrollIntoView, 1);

  b.get("outline-toggle").emit("click");
  assert.equal(b.get("outline").classList.contains("collapsed"), true);
  assert.equal(b.get("outline-tree").hidden, true);
  assert.equal(b.get("pages").classList.contains("outline-collapsed"), true);
  b.get("outline-toggle").emit("click");
  assert.equal(b.get("outline-tree").hidden, false);
});

test("outline uses optional titles and falls back to type without rendering content again", () => {
  const b = browser();
  b.snapshot(
    document([page("p", [{ ...text("a"), title: "Overview" }, chart("c")])]),
  );
  const entries = outlinePage(b, "p").children[1].children;
  const a = entries[0];
  const c = entries[1];
  assert.equal(a.children[0].textContent, "Overview");
  assert.equal(c.children[0].textContent, "chart");
  const markdownCount = b.markdown.length;
  b.operations(1, [update([{ ...text("a"), title: "Renamed" }])]);
  assert.equal(entries[0], a);
  assert.equal(a.children[0].textContent, "Renamed");
  assert.equal(b.markdown.length, markdownCount);
  b.operations(2, [update([text("a")])]);
  assert.equal(a.children[0].textContent, "text");
  assert.equal(b.markdown.length, markdownCount);
});

test("operations create a page and insert complete blocks in one batch, then insert in the middle", () => {
  const b = browser();
  b.snapshot(initial());
  const oldTree = subtree(b.get("pages")).slice(1);
  b.resetWrites();
  b.operations(1, [
    { type: "page:create", page: page("new", [], "New page"), index: 1 },
    {
      type: "blocks:insert",
      pageId: "new",
      index: 0,
      blocks: [text("x"), text("z")],
    },
  ]);
  assert.deepEqual(
    b.get("pages").children.map((p) => p.dataset.pageId),
    ["p1", "new", "p2"],
  );
  assert.equal(b.page("new").children[0].textContent, "New page");
  assert.deepEqual(blockOrder(b.page("new")), ["x", "z"]);
  assert.deepEqual(
    b.get("outline-list").children.map((entry) => entry.dataset.pageId),
    ["p1", "new", "p2"],
  );
  assert.deepEqual(outlineBlockOrder(b, "new"), ["x", "z"]);
  assert.equal(writeCount(oldTree), 0);
  const x = b.block("x");
  const z = b.block("z");
  b.resetWrites();
  b.operations(2, [
    {
      type: "blocks:insert",
      pageId: "new",
      index: 1,
      blocks: [text("y"), chart("fresh-chart")],
    },
  ]);
  assert.deepEqual(blockOrder(b.page("new")), ["x", "y", "fresh-chart", "z"]);
  assert.deepEqual(outlineBlockOrder(b, "new"), ["x", "y", "fresh-chart", "z"]);
  assert.equal(b.block("x"), x);
  assert.equal(b.block("z"), z);
  assert.equal(writeCount([...oldTree, ...subtree(x), ...subtree(z)]), 0);
  assert.deepEqual(b.markdown, ["a", "b", "d", "x", "z", "y"]);
  assert.equal(b.charts.length, 2);
  select(b, "y");
  b.get("reply").emit("click");
  assert.equal(
    b.get("reply-context").textContent,
    "1 selected blocks · document version 3",
  );
  assert.equal(
    b.get("selected-summaries").children[0].textContent,
    "New page · text: y",
  );
});

test("operations update only the referenced block, without even reading an unrelated saved spec", () => {
  const b = browser();
  b.snapshot(initial());
  // ECharts receives the exact parsed spec object held by the real client.
  // Poison it through the public renderer boundary, not by accessing VM state.
  let reads = 0;
  Object.defineProperty(b.charts[0].options[0], "series", {
    enumerable: true,
    get() {
      reads++;
      throw new Error("unrelated chart spec was scanned");
    },
  });
  const a = b.block("a");
  const untouched = [
    b.get("pages"),
    b.page("p1"),
    ...subtree(b.page("p1").children[0]),
    b.page("p1").children[1],
    ...subtree(b.block("b")),
    ...subtree(b.block("c")),
    ...subtree(b.page("p2")),
  ];
  b.resetWrites();
  b.operations(1, [update([text("a", "complete **replacement**")])]);
  assert.equal(b.block("a"), a);
  assert.equal(content(a).innerHTML, "<p>complete **replacement**</p>");
  assert.equal(content(a).writes.innerHTML, 1);
  assert.equal(writeCount(untouched), 0);
  b.resetWrites();
  b.operations(2, [
    update([{ ...text("a", "complete **replacement**"), align: "right" }]),
  ]);
  assert.equal(a.dataset.align, "right");
  assert.equal(a.writes["dataset.align"], 1);
  assert.equal(writeCount([...untouched, ...subtree(content(a))]), 0);
  assert.deepEqual(b.markdown, ["a", "b", "d", "complete **replacement**"]);
  assert.equal(reads, 0);
  assert.equal(b.charts[0].options.length, 1);
  assert.equal(b.charts[0].disposed, 0);
  assert.equal(b.observers[0].disconnected, 0);
  assert.deepEqual(b.socket().sent, []);
});

test("operations reuse charts, dispose on type change and deletion, and keep selection and reply references current", () => {
  const b = browser();
  b.snapshot(initial());
  select(b, "a");
  select(b, "c");
  const c = b.block("c");
  const instance = b.charts[0];
  const observer = b.observers[0];
  const otherPage = subtree(b.page("p2"));
  const revised = {
    ...chart("c"),
    spec: { series: [{ type: "line", data: [9, 8] }] },
  };
  b.resetWrites();
  b.operations(1, [update([revised, text("a", "the complete new content")])]);
  assert.equal(b.block("c"), c);
  assert.equal(b.charts.length, 1);
  assert.equal(instance.options.length, 2);
  assert.deepEqual(
    JSON.parse(JSON.stringify(instance.options[1])),
    revised.spec,
  );
  assert.equal(instance.disposed, 0);
  assert.equal(observer.disconnected, 0);
  assert.equal(writeCount(otherPage), 0);
  for (const id of ["a", "c"]) {
    assert.equal(b.block(id).children[0].checked, true);
    assert.equal(b.block(id).classList.contains("selected"), true);
  }
  b.operations(2, [update([text("c", "chart replaced in full")])]);
  assert.equal(b.block("c"), c);
  assert.equal(content(c).innerHTML, "<p>chart replaced in full</p>");
  assert.equal(instance.disposed, 1);
  assert.equal(observer.disconnected, 1);
  b.operations(3, [update([chart("c")])]);
  assert.equal(b.charts.length, 2);
  b.operations(4, [update([], ["c"])]);
  assert.equal(c.parentNode, null);
  assert.equal(b.charts[1].disposed, 1);
  assert.equal(b.observers[1].disconnected, 1);
  assert.equal(b.get("selection-count").textContent, "1 selected");
  b.get("reply").emit("click");
  assert.deepEqual(
    b.get("selected-summaries").children.map((n) => n.textContent),
    ["p1 · text: the complete new content"],
  );
  b.get("reply-text").value = "Please revise";
  b.get("reply-form").emit("submit");
  const reply = b.socket().sent.find((m) => m.type === "reply");
  assert.deepEqual(reply?.blockIds, ["a"]);
  assert.equal(reply?.version, 5);
  assert.equal(reply?.reply, "Please revise");
  b.message({ type: "ack", requestId: "test-request" });
  assert.equal(b.get("selection-count").textContent, "0 selected");
  b.window.emit("pagehide");
  for (const chart of b.charts) assert.equal(chart.disposed, 1);
  for (const observer of b.observers) assert.equal(observer.disconnected, 1);
});

test("operations re-report cached render errors each version and retry failed sends without rendering again", () => {
  const b = browser();
  b.snapshot(document([page("p", [text("good")])]));
  b.operations(1, [
    {
      type: "blocks:insert",
      pageId: "p",
      index: 1,
      blocks: [text("bad", "BROKEN")],
    },
  ]);
  const errors = () =>
    b.sockets.flatMap((s) => s.sent).filter((m) => m.type === "render:error");
  const errorTree = subtree(b.block("bad"));
  b.resetWrites();
  b.operations(2, [update([text("good", "next")])]);
  assert.deepEqual(
    errors().map((m) => m.version),
    [2, 3],
  );
  assert.equal(writeCount(errorTree), 0);
  b.socket().failSend = true;
  b.operations(3, [update([text("good", "again")])]);
  assert.deepEqual(
    errors().map((m) => m.version),
    [2, 3],
  );
  b.reconnect();
  const doc = document(
    [page("p", [text("good", "again"), text("bad", "BROKEN")])],
    4,
  );
  b.resetWrites();
  b.snapshot(doc);
  b.snapshot(doc);
  assert.deepEqual(
    errors().map((m) => m.version),
    [2, 3, 4],
  );
  assert.equal(errors()[2].blockId, "bad");
  assert.match(errors()[2].message ?? "", /invalid markdown/);
  assert.equal(writeCount(errorTree), 0);
  assert.deepEqual(b.markdown, ["good", "BROKEN", "next", "again"]);
  b.operations(4, [update([text("bad", "fixed")])]);
  b.operations(5, [update([text("good", "final")])]);
  assert.equal(errors().length, 3);
  assert.equal(content(b.block("bad")).innerHTML, "<p>fixed</p>");
});

test("operations are ignored before the initial snapshot and after reconnect until a snapshot", () => {
  const b = browser();
  const ops: Operation[] = [
    { type: "page:create", page: page("p", []), index: 0 },
    { type: "blocks:insert", pageId: "p", index: 0, blocks: [text("a")] },
  ];
  b.operations(0, ops);
  assert.equal(b.get("pages").children.length, 0);
  assert.deepEqual(b.markdown, []);
  assert.deepEqual(b.socket().sent, []);
  b.snapshot(document([], 0));
  b.operations(0, ops);
  assert.equal(content(b.block("a")).innerHTML, "<p>a</p>");
  b.reconnect();
  b.operations(1, [update([text("a", "ignored")])]);
  assert.equal(content(b.block("a")).innerHTML, "<p>a</p>");
  assert.equal(b.get("reply").disabled, true);
  b.snapshot(document([page("p", [text("a")])], 1));
  b.operations(1, [update([text("a", "accepted")])]);
  assert.equal(content(b.block("a")).innerHTML, "<p>accepted</p>");
});

const invalidMessages: { name: string; fields: Record<string, unknown> }[] = [
  { name: "version gap", fields: { baseVersion: 2, version: 3 } },
  { name: "invalid next version", fields: { version: 3 } },
  { name: "wrong document ID", fields: { documentId: "other-document" } },
  {
    name: "unknown block ID",
    fields: { operations: [update([text("missing")])] },
  },
  {
    name: "unknown page ID",
    fields: {
      operations: [
        {
          type: "blocks:insert",
          pageId: "missing",
          index: 0,
          blocks: [text("x")],
        },
      ],
    },
  },
  {
    name: "unknown removed ID",
    fields: { operations: [update([], ["missing"])] },
  },
  {
    name: "unknown operation",
    fields: { operations: [{ type: "page:delete", pageId: "p1" }] },
  },
  {
    name: "invalid block",
    fields: {
      operations: [
        update([{ ...text("a"), align: "invalid" } as unknown as Block]),
      ],
    },
  },
  {
    name: "out-of-range insertion",
    fields: {
      operations: [
        { type: "blocks:insert", pageId: "p1", index: 99, blocks: [text("x")] },
      ],
    },
  },
  {
    name: "duplicate inserted ID",
    fields: {
      operations: [
        { type: "blocks:insert", pageId: "p1", index: 0, blocks: [text("a")] },
      ],
    },
  },
  { name: "empty batch", fields: { operations: [] } },
  { name: "non-array batch", fields: { operations: {} } },
];
for (const { name, fields } of invalidMessages) {
  test(`operations reject ${name}, request resync once, and recover only from snapshot`, () => {
    const b = browser();
    b.snapshot(initial());
    select(b, "a");
    b.get("reply").emit("click");
    b.get("reply-text").value = "preserve my draft";
    const tree = subtree(b.get("pages"));
    b.resetWrites();
    const message = {
      type: "operations",
      documentId: "test-document",
      baseVersion: 1,
      version: 2,
      operations: [update([text("a", "must not apply")])],
      ...fields,
    };
    b.message(message);
    b.message(message);
    b.operations(1, [update([text("a", "also ignored")])]);
    assert.deepEqual(b.socket().sent, [{ type: "resync" }]);
    assert.equal(b.get("reply").disabled, true);
    assert.equal(b.get("submit").disabled, true);
    assert.equal(b.get("reply-text").value, "preserve my draft");
    assert.equal(writeCount(tree), 0);
    assert.deepEqual(b.markdown, ["a", "b", "d"]);
    b.snapshot(
      document([page("recovered", [text("a", "recovered content")])], 10),
    );
    assert.equal(b.get("reply").disabled, false);
    assert.equal(b.get("selection-count").textContent, "1 selected");
    b.operations(10, [update([text("a", "live again")])]);
    assert.equal(content(b.block("a")).innerHTML, "<p>live again</p>");
    b.get("cancel").emit("click");
    b.get("reply").emit("click");
    assert.equal(
      b.get("reply-context").textContent,
      "1 selected blocks · document version 11",
    );
  });
}

test("replaying a successfully consumed operation batch requests resync instead of applying twice", () => {
  const b = browser();
  b.snapshot(initial());
  const ops: Operation[] = [
    { type: "blocks:insert", pageId: "p1", index: 1, blocks: [text("x")] },
  ];
  b.operations(1, ops);
  const tree = subtree(b.get("pages"));
  b.resetWrites();
  b.operations(1, ops);
  b.operations(2, [update([text("a", "ignored")])]);
  assert.deepEqual(blockOrder(b.page("p1")), ["a", "x", "b", "c"]);
  assert.equal(writeCount(tree), 0);
  assert.deepEqual(b.socket().sent, [{ type: "resync" }]);
  b.snapshot(
    document(
      [
        page("p1", [text("a"), text("x"), text("b"), chart("c")]),
        page("p2", [text("d")]),
      ],
      2,
    ),
  );
  b.operations(2, [update([text("x", "accepted")])]);
  assert.equal(content(b.block("x")).innerHTML, "<p>accepted</p>");
});

for (const first of [
  { type: "page:create", page: page("new", []), index: 1 },
  {
    type: "blocks:insert",
    pageId: "p1",
    index: 1,
    blocks: [chart("new-chart")],
  },
  update([text("a", "must not render")], ["c"]),
] satisfies Operation[]) {
  test(`invalid batch second operation cannot partially apply ${first.type}`, () => {
    const b = browser();
    b.snapshot(initial());
    select(b, "c");
    const tree = subtree(b.get("pages"));
    b.resetWrites();
    b.operations(1, [first, update([text("missing")])]);
    assert.equal(writeCount(tree), 0);
    assert.deepEqual(subtree(b.get("pages")), tree);
    assert.deepEqual(b.markdown, ["a", "b", "d"]);
    assert.equal(b.charts.length, 1);
    assert.equal(b.charts[0].disposed, 0);
    assert.equal(b.observers[0].disconnected, 0);
    assert.equal(b.get("selection-count").textContent, "1 selected");
    assert.deepEqual(b.socket().sent, [{ type: "resync" }]);
    b.snapshot(initial());
    b.get("reply").emit("click");
    assert.equal(
      b.get("reply-context").textContent,
      "1 selected blocks · document version 1",
    );
    b.operations(1, [first]);
    assert.deepEqual(b.socket().sent, [{ type: "resync" }]);
    if (first.type === "page:create")
      assert.equal(b.page("new").children[0].textContent, "new");
    else if (first.type === "blocks:insert") assert.equal(b.charts.length, 2);
    else
      assert.equal(content(b.block("a")).innerHTML, "<p>must not render</p>");
  });
}

test("a failed resync send closes the transport and reconnects before accepting more operations", () => {
  const b = browser();
  b.snapshot(initial());
  select(b, "a");
  const failedSocket = b.socket();
  failedSocket.failSend = true;
  b.operations(7, [update([text("a", "gap")])]);
  assert.equal(failedSocket.readyState, 3);
  assert.deepEqual(failedSocket.sent, []);
  assert.equal(b.get("reply").disabled, true);
  b.runReconnect();
  assert.equal(b.sockets.length, 2);
  assert.notEqual(b.socket(), failedSocket);
  b.operations(1, [update([text("a", "ignored")])]);
  assert.equal(content(b.block("a")).innerHTML, "<p>a</p>");
  b.snapshot(initial());
  b.operations(1, [update([text("a", "after reconnect")])]);
  assert.equal(content(b.block("a")).innerHTML, "<p>after reconnect</p>");
  assert.equal(b.get("reply").disabled, false);
});

test("full identical snapshots (including a new version) do not write page or block DOM", () => {
  const b = browser();
  const doc = initial();
  b.snapshot(doc);
  assert.equal(b.socket().url, "ws://canvas.test/ws");
  assert.deepEqual(b.markdown, ["a", "b", "d"]);
  assert.equal(b.sanitized.length, 3);
  const tree = subtree(b.get("pages"));
  const c = b.charts[0];
  const observer = b.observers[0];
  for (const version of [1, 2, 2]) {
    b.resetWrites();
    b.snapshot({ ...doc, version });
    assert.equal(
      writeCount(tree),
      0,
      `page/block writes at version ${version}`,
    );
    assert.deepEqual(subtree(b.get("pages")), tree);
  }
  assert.deepEqual(b.markdown, ["a", "b", "d"]);
  assert.equal(b.charts.length, 1);
  assert.equal(c.options.length, 1);
  assert.equal(c.disposed, 0);
  assert.equal(observer.disconnected, 0);
});

test("one text revision renders only that block and leaves other pages and chart instances untouched", () => {
  const b = browser();
  const doc = initial();
  b.snapshot(doc);
  const a = b.block("a");
  const aContent = content(a);
  const untouched = [
    b.get("pages"),
    b.page("p1"),
    ...subtree(b.page("p1").children[0]),
    b.page("p1").children[1],
    ...subtree(b.block("b")),
    ...subtree(b.block("c")),
    ...subtree(b.page("p2")),
  ];
  b.resetWrites();
  doc.version++;
  doc.pages[0].blocks[0].spec = { md: "updated **a**" };
  b.snapshot(doc);
  assert.equal(b.block("a"), a);
  assert.equal(content(a), aContent);
  assert.equal(aContent.innerHTML, "<p>updated **a**</p>");
  assert.equal(aContent.writes.innerHTML, 1);
  assert.equal(writeCount(untouched), 0);
  assert.deepEqual(b.markdown, ["a", "b", "d", "updated **a**"]);
  assert.equal(b.sanitized.length, 4);
  assert.equal(b.charts.length, 1);
  assert.equal(b.charts[0].options.length, 1);
  assert.equal(b.charts[0].disposed, 0);
  assert.equal(b.observers[0].disconnected, 0);
});

test("align-only changes do not render content; title-only changes do not touch blocks", () => {
  const b = browser();
  const doc = initial();
  b.snapshot(doc);
  const a = b.block("a");
  const c = b.block("c");
  const unaffected = [
    ...subtree(b.block("b")),
    ...subtree(b.page("p2")),
    ...subtree(content(a)),
    ...subtree(content(c)),
  ];
  b.resetWrites();
  doc.version++;
  doc.pages[0].blocks[0].align = "right";
  doc.pages[0].blocks[2].align = "center";
  b.snapshot(doc);
  assert.equal(a.dataset.align, "right");
  assert.equal(c.dataset.align, "center");
  assert.equal(a.writes["dataset.align"], 1);
  assert.equal(c.writes["dataset.align"], 1);
  assert.equal(writeCount(unaffected), 0);
  assert.equal(b.markdown.length, 3);
  assert.equal(b.charts[0].options.length, 1);

  b.resetWrites();
  const allBlocks = doc.pages.flatMap((p) =>
    p.blocks.flatMap((block) => subtree(b.block(block.id))),
  );
  const otherPage = subtree(b.page("p2"));
  doc.version++;
  doc.pages[0].title = "Renamed page";
  b.snapshot(doc);
  assert.equal(b.page("p1").children[0].textContent, "Renamed page");
  assert.equal(writeCount(allBlocks), 0);
  assert.equal(writeCount(otherPage), 0);
  assert.equal(b.get("pages").writes.insertBefore ?? 0, 0);
  assert.equal(b.markdown.length, 3);
  assert.equal(b.charts[0].options.length, 1);
  // The record metadata must still reflect the title without re-rendering.
  a.children[0].checked = true;
  a.children[0].emit("change");
  b.get("reply").emit("click");
  assert.match(
    b.get("selected-summaries").children[0].textContent,
    /^Renamed page · text/,
  );
});

test("page/block insertion, reordering and cross-page moves retain keyed DOM and chart instances", () => {
  const b = browser();
  b.snapshot(initial());
  const p1 = b.page("p1");
  const p2 = b.page("p2");
  const saved = new Map(["a", "b", "c", "d"].map((id) => [id, b.block(id)]));
  const savedContents = [...saved.values()].map(content);
  const c = b.charts[0];
  b.resetWrites();
  b.snapshot(
    document(
      [
        page("p2", [chart("c"), text("e"), text("d")]),
        page("p3", [text("f")]),
        page("p1", [text("b"), text("a")]),
      ],
      2,
    ),
  );
  assert.deepEqual(
    b.get("pages").children.map((p) => p.dataset.pageId),
    ["p2", "p3", "p1"],
  );
  assert.equal(b.page("p1"), p1);
  assert.equal(b.page("p2"), p2);
  assert.deepEqual(blockOrder(p1), ["b", "a"]);
  assert.deepEqual(blockOrder(p2), ["c", "e", "d"]);
  for (const [id, node] of saved) assert.equal(b.block(id), node);
  assert.equal(writeCount(savedContents.flatMap(subtree)), 0);
  assert.ok((b.get("pages").writes.insertBefore ?? 0) > 0);
  assert.equal(b.charts[0], c);
  assert.equal(b.charts.length, 1);
  assert.equal(c.options.length, 1);
  assert.equal(c.disposed, 0);
  assert.equal(b.observers[0].disconnected, 0);
  assert.deepEqual(b.markdown, ["a", "b", "d", "e", "f"]);

  // Move out of a deleted page: cleanup must not dispose a surviving chart.
  b.snapshot(document([page("p1", [chart("c"), text("a")])], 3));
  assert.equal(b.page("p1"), p1);
  assert.equal(b.block("c"), saved.get("c"));
  assert.equal(b.block("a"), saved.get("a"));
  assert.deepEqual(blockOrder(p1), ["c", "a"]);
  assert.equal(p2.parentNode, null);
  assert.equal(saved.get("b")?.parentNode, null);
  assert.equal(saved.get("d")?.parentNode, null);
  assert.equal(c.disposed, 0);
  assert.equal(b.observers[0].disconnected, 0);
});

test("chart revision reuses the renderer; deletion disposes it and disconnects its observer exactly once", () => {
  const b = browser();
  b.snapshot(document([page("p", [chart("c"), text("a")])]));
  const c = b.block("c");
  const instance = b.charts[0];
  const observer = b.observers[0];
  const a = subtree(b.block("a"));
  b.resetWrites();
  const revised = chart("c");
  revised.spec = { series: [{ type: "line", data: [3] }] };
  b.snapshot(document([page("p", [revised, text("a")])], 2));
  assert.equal(b.block("c"), c);
  assert.equal(b.charts.length, 1);
  assert.equal(instance.options.length, 2);
  assert.equal(writeCount(a), 0);
  assert.deepEqual(observer.targets, [content(c)]);
  b.snapshot(document([page("p", [text("a")])], 3));
  assert.equal(c.parentNode, null);
  assert.equal(instance.disposed, 1);
  assert.equal(observer.disconnected, 1);
  b.snapshot(document([], 4));
  b.snapshot(document([], 4));
  b.window.emit("pagehide");
  assert.equal(instance.disposed, 1);
  assert.equal(observer.disconnected, 1);
});

test("chart type changes dispose resources; math/table/divider duplicate snapshots do not render again", () => {
  const b = browser();
  b.snapshot(document([page("p", [chart("to-text"), chart("to-math")])]));
  const textBlock = b.block("to-text");
  const mathBlock = b.block("to-math");
  const doc = document(
    [
      page("p", [
        text("to-text", "replacement"),
        { id: "to-math", type: "math", align: "left", spec: { latex: "x^2" } },
        {
          id: "table",
          type: "table",
          align: "left",
          spec: { columns: ["Name"], rows: [["Alice"]] },
        },
        { id: "divider", type: "divider", align: "left", spec: {} },
      ]),
    ],
    2,
  );
  b.snapshot(doc);
  assert.equal(b.block("to-text"), textBlock);
  assert.equal(b.block("to-math"), mathBlock);
  assert.equal(content(textBlock).innerHTML, "<p>replacement</p>");
  assert.equal(content(mathBlock).textContent, "x^2");
  assert.deepEqual(b.markdown, ["replacement"]);
  assert.deepEqual(b.math, ["x^2"]);
  const table = content(b.block("table")).children[0];
  assert.equal(table.tagName, "table");
  assert.equal(table.children[0].children[0].children[0].textContent, "Name");
  assert.equal(table.children[1].children[0].children[0].textContent, "Alice");
  assert.equal(content(b.block("divider")).children[0].tagName, "hr");
  for (const instance of b.charts) assert.equal(instance.disposed, 1);
  for (const observer of b.observers) assert.equal(observer.disconnected, 1);
  const tree = subtree(b.get("pages"));
  b.resetWrites();
  b.snapshot(doc);
  b.snapshot({ ...doc, version: 3 });
  assert.equal(writeCount(tree), 0);
  assert.deepEqual(subtree(b.get("pages")), tree);
  assert.deepEqual(b.markdown, ["replacement"]);
  assert.deepEqual(b.math, ["x^2"]);
  assert.equal(b.charts.length, 2);
  for (const instance of b.charts) assert.equal(instance.disposed, 1);
  for (const observer of b.observers) assert.equal(observer.disconnected, 1);
});

test("selection survives updates and moves, while deleted IDs are removed from the reply payload", () => {
  const b = browser();
  b.snapshot(initial());
  const a = b.block("a");
  const c = b.block("c");
  for (const block of [a, c]) {
    block.children[0].checked = true;
    block.children[0].emit("change");
  }
  b.snapshot(document([page("p2", [chart("c"), text("a", "new a")])], 2));
  assert.equal(b.get("selection-count").textContent, "2 selected");
  for (const block of [a, c]) {
    assert.equal(block.children[0].checked, true);
    assert.equal(block.classList.contains("selected"), true);
  }
  b.snapshot(document([page("p2", [text("a", "new a")])], 3));
  assert.equal(b.get("selection-count").textContent, "1 selected");
  b.get("reply").emit("click");
  assert.equal(b.get("selected-summaries").children.length, 1);
  assert.match(b.get("selected-summaries").children[0].textContent, /new a/);
  b.get("reply-text").value = "Please revise";
  b.get("reply-form").emit("submit");
  const reply = b.socket().sent.find((message) => message.type === "reply");
  assert.deepEqual(reply?.blockIds, ["a"]);
  assert.equal(reply?.version, 3);
  b.snapshot(document([], 4));
  assert.equal(b.get("selection-count").textContent, "0 selected");
  assert.equal(b.get("reply").disabled, true);
  assert.equal(b.get("clear").disabled, true);
});

test("render errors are sent once per block per version, not on duplicate snapshots or reconnect", () => {
  const b = browser();
  const doc = document([page("p", [text("bad", "BROKEN"), text("good")])]);
  b.snapshot(doc);
  const errors = () =>
    b.sockets
      .flatMap((socket) => socket.sent)
      .filter((m) => m.type === "render:error");
  assert.deepEqual(
    errors().map(({ blockId, version }) => ({ blockId, version })),
    [{ blockId: "bad", version: 1 }],
  );
  assert.match(errors()[0].message ?? "", /invalid markdown/);
  const errorDOM = subtree(b.block("bad"));
  b.resetWrites();
  b.snapshot(doc);
  assert.equal(errors().length, 1);
  assert.equal(writeCount(errorDOM), 0);
  b.snapshot({ ...doc, version: 2 });
  b.snapshot({ ...doc, version: 2 });
  assert.deepEqual(
    errors().map((m) => m.version),
    [1, 2],
  );
  b.reconnect();
  b.snapshot({ ...doc, version: 2 });
  assert.equal(errors().length, 2);
  assert.deepEqual(b.markdown, ["BROKEN", "good"]);
  // A fixed content revision clears the cached error.
  b.snapshot(document([page("p", [text("bad", "fixed"), text("good")])], 3));
  b.snapshot(document([page("p", [text("bad", "fixed"), text("good")])], 4));
  assert.equal(errors().length, 2);
  assert.equal(content(b.block("bad")).innerHTML, "<p>fixed</p>");
});

test("a failed render:error send is retried after reconnect without rendering the block again", () => {
  const b = browser();
  const doc = document([page("p", [text("bad", "BROKEN")])]);
  b.socket().failSend = true;
  b.snapshot(doc);
  assert.equal(b.socket().sent.length, 0);
  const tree = subtree(b.get("pages"));
  b.reconnect();
  b.resetWrites();
  b.snapshot(doc);
  b.snapshot(doc);
  const errors = b.socket().sent.filter((m) => m.type === "render:error");
  assert.equal(errors.length, 1);
  assert.equal(errors[0].version, 1);
  assert.equal(errors[0].blockId, "bad");
  assert.deepEqual(b.markdown, ["BROKEN"]);
  assert.equal(writeCount(tree), 0);
});
