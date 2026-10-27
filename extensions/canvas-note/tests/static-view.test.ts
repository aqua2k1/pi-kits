import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate as settle } from "node:timers/promises";
import { browser, subtree } from "./fixtures/browser.ts";

const doc = {
  version: 7,
  pages: [
    {
      id: "p",
      title: "Static document",
      blocks: [
        {
          id: "text",
          type: "text",
          align: "left",
          spec: { md: "# Heading\n\nSource" },
        },
        {
          id: "code",
          type: "code",
          align: "left",
          spec: { language: "javascript", code: "const answer = 42;" },
        },
        { id: "math", type: "math", align: "left", spec: { latex: "x^2" } },
        {
          id: "chart",
          type: "chart",
          align: "left",
          spec: { series: [{ type: "bar", data: [1, 2] }] },
        },
        {
          id: "table",
          type: "table",
          align: "left",
          spec: { columns: ["A"], rows: [[1]] },
        },
        { id: "divider", type: "divider", align: "left", spec: {} },
      ],
    },
  ],
};
const payload = {
  doc,
  documentId: "static-id",
  title: "Saved document",
  view: {
    outlineMode: "semantic",
    collapsed: true,
    folds: [["page:p", false]],
  },
};

test("nonblank embedded document renders all block kinds without online registrations", () => {
  const b = browser(payload);
  assert.equal(b.documentElement.dataset.mode, "static");
  assert.equal(b.sockets.length, 0);
  assert.equal(b.timers.size, 0);
  assert.deepEqual(b.window.listenerTypes().sort(), [
    "afterprint",
    "beforeprint",
  ]);
  for (const id of [
    "reply",
    "clear",
    "save-html",
    "save-pdf",
    "shutdown",
    "shutdown-confirm",
    "reply-form",
    "reply-dialog",
    "export-menu",
  ])
    assert.deepEqual(b.get(id).listenerTypes(), [], id);
  for (const node of subtree(b.get("pages"))) {
    if (node.className === "block-select" || node.className === "page-select")
      assert.deepEqual(node.listenerTypes(), []);
  }
  assert.equal(b.page("p").id, "page-p");
  assert.equal(b.block("text").id, "block-text");
  assert.equal(b.block("code").querySelectorAll("code")[0].className, "hljs");
  assert.deepEqual(b.math, ["x^2"]);
  assert.equal(b.block("table").querySelectorAll("table").length, 1);
  assert.equal(b.block("divider").querySelectorAll("hr").length, 1);
  assert.equal(b.charts.length, 1);
  assert.equal(b.charts[0].options.length, 1);
  b.window.emit("beforeunload");
  b.window.emit("pagehide");
  assert.equal(b.charts[0].disposed, 0);
  assert.equal(b.timers.size, 0);
});

test("static outline restores view and keeps local navigation, switching and folding", () => {
  const b = browser(payload);
  assert.equal(b.get("outline").classList.contains("collapsed"), true);
  assert.equal(
    b.get("outline-mode-semantic").getAttribute("aria-pressed"),
    "true",
  );
  const page = b.get("outline-list").children[0];
  assert.equal(page.children[1].hidden, true);
  b.get("outline-toggle").emit("click");
  assert.equal(b.get("outline-tree").hidden, false);
  b.get("outline-expand-all").emit("click");
  assert.equal(page.children[1].hidden, false);
  const headingLink = b
    .get("outline-list")
    .querySelectorAll(".outline-block-link")[0];
  headingLink.emit("click");
  assert.equal(
    b.block("text").children[1].children[0].writes.scrollIntoView,
    1,
  );
  b.get("outline-mode-structure").emit("click");
  const blockLink = b
    .get("outline-list")
    .querySelectorAll(".outline-block-link")[0];
  blockLink.emit("click");
  assert.equal(b.block("text").writes.scrollIntoView, 1);
  b.get("outline-collapse-all").emit("click");
  assert.equal(page.children[1].hidden, true);
  assert.equal(b.markdown.length, 1);
  assert.equal(b.charts[0].options.length, 1);
  assert.equal(b.sockets.length, 0);
});

test("static copy and print use the shared source data and chart lifecycle", async () => {
  const b = browser(payload);
  b.block("code").querySelectorAll(".block-copy")[0].emit("click");
  await settle();
  assert.deepEqual(b.clipboard.texts, ["const answer = 42;"]);
  b.window.emit("beforeprint");
  b.window.emit("afterprint");
  assert.equal(b.charts[0].themes.length, 2);
  assert.equal(b.charts[0].resizes, 2);
  assert.equal(b.charts[0].disposed, 0);
  assert.equal(b.charts[0].options.length, 1);
  b.runTimers();
  assert.equal(b.sockets.length, 0);
});

test("blank data placeholder remains online; static render failures never report or retry", () => {
  const online = browser(" \n ");
  assert.equal(online.documentElement.dataset.mode, "online");
  assert.equal(online.sockets.length, 1);
  assert.ok(online.window.listenerTypes().includes("beforeunload"));
  const broken = structuredClone(payload);
  broken.doc.pages[0].blocks[0].spec = { md: "BROKEN" };
  const b = browser(broken);
  assert.match(
    b.block("text").children[1].children[0].textContent,
    /Unable to render/,
  );
  assert.equal(b.sockets.length, 0);
  assert.equal(b.timers.size, 0);
});
