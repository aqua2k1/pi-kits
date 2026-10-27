import assert from "node:assert/strict";
import { test } from "node:test";
import type { Block, Document } from "../core/model.ts";
import { browser, subtree, writeCount } from "./fixtures/browser.ts";

const text = (id: string, md: string): Block => ({
  id,
  type: "text",
  align: "left",
  spec: { md },
});
const chart: Block = {
  id: "chart",
  type: "chart",
  align: "left",
  spec: { series: [] },
};
const doc = (): Document => ({
  version: 1,
  pages: [
    {
      id: "p",
      title: "Report",
      blocks: [
        {
          ...text(
            "a",
            "# **Same** [link](https://example.com)\n\n```md\n# Not a heading\n```\n\n<h2>Raw HTML</h2>",
          ),
          title: "Logical title",
        },
        chart,
        text("b", "### Same\n\nSecond\n======\n\n> #### Quoted"),
      ],
    },
    { id: "empty", title: "Empty", blocks: [] },
  ],
});
const headings = (b: ReturnType<typeof browser>) =>
  subtree(b.get("outline-list")).filter((node) =>
    node.classList.contains("outline-heading"),
  );
const link = (entry: ReturnType<typeof headings>[number]) =>
  entry.children[0].children[1];
const targets = (b: ReturnType<typeof browser>, id: string) =>
  subtree(b.block(id)).filter(
    (node) => node.dataset.outlineHeading !== undefined,
  );

test("semantic outline derives parsed headings across blocks and switches without rendering or selection changes", () => {
  const b = browser();
  b.snapshot(doc());
  const checkbox = b.block("a").children[0];
  checkbox.checked = true;
  checkbox.emit("change");
  const rendered = b.markdown.length;
  b.get("outline-mode-semantic").emit("click");
  assert.equal(
    b.get("outline-mode-semantic").attributes["aria-pressed"],
    "true",
  );
  assert.deepEqual(
    headings(b).map((entry) => link(entry).textContent),
    ["Same link", "Same", "Second", "Quoted"],
  );
  const list = b.get("outline-list");
  assert.equal(list.children.length, 2);
  assert.equal(list.children[1].children[1].children.length, 0);
  assert.equal(list.children[0].children[1].children.length, 2);
  assert.equal(headings(b)[0].children[1].children[0], headings(b)[1]);
  assert.equal(headings(b)[2].children[1].children[0], headings(b)[3]);
  link(headings(b)[0]).emit("click");
  assert.equal(targets(b, "a")[0].writes.scrollIntoView, 1);
  assert.equal(b.markdown.length, rendered);
  assert.equal(b.charts.length, 1);
  assert.equal(b.charts[0].disposed, 0);
  assert.equal(checkbox.checked, true);
  const first = headings(b)[0];
  first.children[0].children[0].emit("click");
  assert.equal(first.children[1].hidden, true);
  b.get("outline-mode-structure").emit("click");
  const a = subtree(list).find((entry) => entry.dataset.blockId === "a");
  assert.equal(a?.children[0].textContent, "Logical title");
  b.get("outline-mode-semantic").emit("click");
  assert.equal(headings(b)[0].children[1].hidden, true);
  assert.equal(b.markdown.length, rendered);
});

test("semantic outline retains unchanged DOM and refreshes anchors after revisions and deletes", () => {
  const b = browser();
  b.snapshot(doc());
  b.get("outline-mode-semantic").emit("click");
  b.resetWrites();
  b.snapshot(doc());
  assert.equal(writeCount(subtree(b.get("pages"))), 0);
  assert.equal(writeCount(subtree(b.get("outline-list"))), 0);
  const oldTarget = targets(b, "a")[0];
  const oldEntry = headings(b)[0];
  const untouched = b.get("outline-list").children[1];
  b.resetWrites();
  b.operations(1, [
    { type: "blocks:update", blocks: [text("a", "## Revised")], removed: [] },
  ]);
  assert.equal(headings(b)[0], oldEntry);
  assert.equal(link(oldEntry).textContent, "Revised");
  link(oldEntry).emit("click");
  assert.equal(oldTarget.writes.scrollIntoView, undefined);
  assert.equal(targets(b, "a")[0].writes.scrollIntoView, 1);
  assert.equal(writeCount(subtree(untouched)), 0);
  b.operations(2, [{ type: "blocks:update", blocks: [], removed: ["a"] }]);
  assert.deepEqual(
    headings(b).map((entry) => link(entry).textContent),
    ["Same", "Second", "Quoted"],
  );
  assert.equal(b.charts[0].disposed, 0);
  b.operations(3, [
    {
      type: "blocks:update",
      blocks: [text("b", "No headings now")],
      removed: [],
    },
  ]);
  assert.equal(headings(b).length, 0);
  assert.equal(
    b.get("outline-list").children[0].children[1].children.length,
    0,
  );
});

test("render failure and changing block type remove stale semantic headings", () => {
  const b = browser();
  b.snapshot(doc());
  b.get("outline-mode-semantic").emit("click");
  b.operations(1, [
    { type: "blocks:update", blocks: [text("a", "BROKEN")], removed: [] },
  ]);
  assert.equal(
    headings(b).some((entry) => link(entry).textContent === "Same link"),
    false,
  );
  b.operations(2, [
    {
      type: "blocks:update",
      blocks: [
        {
          id: "b",
          type: "code",
          align: "left",
          spec: { code: "# Code heading" },
        },
      ],
      removed: [],
    },
  ]);
  assert.equal(headings(b).length, 0);
});
