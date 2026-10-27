import assert from "node:assert/strict";
import { test } from "node:test";
import { Marked } from "marked";
import {
  buildPageOutline,
  headingTargetId,
  headingText,
} from "../web/outline-model.js";
import { createOutlineView } from "../web/outline-view.js";
import { Element, subtree, writeCount } from "./fixtures/browser.ts";

const page = {
  id: "p",
  title: "Report",
  blocks: [
    {
      id: "a",
      type: "text",
      title: "Logical label",
      spec: { md: "# Semantic" },
    },
    { id: "chart", type: "chart", spec: {} },
    { id: "b", type: "text", spec: { md: "### Details\n# Next" } },
  ],
};

test("structural and semantic outline models are pure independent projections", () => {
  const before = structuredClone(page);
  const structural = buildPageOutline(page);
  assert.deepEqual(
    structural.children.map((node) => node.label),
    ["Logical label", "chart", "text"],
  );
  const headings = new Map([
    ["a", [{ ordinal: 0, depth: 1, label: "Same" }]],
    [
      "b",
      [
        { ordinal: 0, depth: 3, label: "Same" },
        { ordinal: 1, depth: 1, label: "Next" },
      ],
    ],
  ]);
  const semantic = buildPageOutline(
    page,
    "semantic",
    (id: string) => headings.get(id) ?? [],
  );
  assert.deepEqual(
    semantic.children.map((node) => node.label),
    ["Same", "Next"],
  );
  assert.equal(semantic.children[0].children[0].label, "Same");
  assert.equal(semantic.children[0].children[0].depth, 3);
  assert.notEqual(semantic.children[0].id, semantic.children[0].children[0].id);
  assert.equal(semantic.children[0].target.id, headingTargetId("a", 0));
  assert.deepEqual(page, before);
  assert.equal(JSON.stringify(semantic).includes("element"), false);
  assert.equal(JSON.stringify(structural).includes("expanded"), false);
});

test("heading labels preserve inline text without Markdown formatting", () => {
  const parser = new Marked();
  const tokens = parser.lexer(
    "# **Bold** [link](https://example.com) `code` ![alt](image.png) &amp; &#x4E2D; <em>HTML</em>",
  );
  const heading = tokens[0];
  assert.equal(heading.type, "heading");
  if (heading.type !== "heading") return;
  assert.equal(headingText(heading.tokens), "Bold link code alt & 中 HTML");
  assert.equal(headingTargetId("a/b", 1), "canvas-heading-a%2Fb-1");
});

test("shared outline view owns DOM, retains stable entries and only navigates targets", () => {
  const root = new Element("ul");
  const target = new Element("section");
  const view = createOutlineView({
    document: { createElement: (tag: string) => new Element(tag) },
    root,
    resolveTarget: () => target,
  });
  const model = buildPageOutline(page);
  view.updatePage(model, 0);
  const existing = subtree(root);
  const before = writeCount(existing);
  view.updatePage(buildPageOutline(page), 0);
  assert.equal(writeCount(existing), before);
  const block = subtree(root).find((node) => node.dataset.blockId === "a");
  assert.ok(block);
  block.children[0].emit("click");
  assert.equal(target.writes.scrollIntoView, 1);
  const toggle = subtree(root).find((node) =>
    node.classList.contains("outline-page-toggle"),
  );
  assert.ok(toggle);
  toggle.emit("click");
  assert.equal(root.children[0].children[1].hidden, true);
  view.updatePage(buildPageOutline(page), 0);
  assert.equal(root.children[0].children[1].hidden, true);
  assert.equal(
    subtree(root).find((node) => node.dataset.blockId === "a"),
    block,
  );
  view.removePage("p");
  assert.equal(root.children.length, 0);
});
