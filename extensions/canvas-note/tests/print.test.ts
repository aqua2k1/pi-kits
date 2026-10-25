import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { setImmediate as settle } from "node:timers/promises";
import { browser, Element } from "./fixtures/browser.ts";

const doc = {
  version: 1,
  pages: [
    {
      id: "p",
      title: "Print test",
      blocks: [
        {
          id: "text",
          type: "text" as const,
          align: "left" as const,
          spec: { md: "Original" },
        },
        {
          id: "chart",
          type: "chart" as const,
          align: "left" as const,
          spec: { series: [{ type: "bar", data: [1] }] },
        },
      ],
    },
  ],
};

test("Save PDF waits for fonts and images and preserves document UI state", async () => {
  const b = browser();
  const button = b.get("save-pdf");
  assert.equal(button.disabled, true);
  b.snapshot(doc);
  assert.equal(button.disabled, false);
  const checkbox = b.block("text").children[0];
  checkbox.checked = true;
  checkbox.emit("change");
  b.get("outline-toggle").emit("click");
  let readyFonts!: () => void;
  let readyImage!: () => void;
  b.fonts.ready = new Promise<void>((resolve) => {
    readyFonts = resolve;
  });
  const image = Object.assign(new Element("img"), {
    decode: () =>
      new Promise<void>((resolve) => {
        readyImage = resolve;
      }),
  });
  b.block("text").children[1].append(image);
  button.emit("click");
  button.emit("click");
  assert.equal(button.disabled, true);
  assert.equal(button.textContent, "Preparing…");
  await settle();
  assert.equal(b.printing.calls, 0);
  readyFonts();
  await settle();
  assert.equal(b.printing.calls, 0);
  readyImage();
  await settle();
  assert.equal(b.printing.calls, 1);
  assert.equal(button.disabled, false);
  assert.equal(button.textContent, "Save PDF");
  assert.equal(checkbox.checked, true);
  assert.equal(b.get("pages").classList.contains("outline-collapsed"), true);
  assert.equal(b.charts[0].resizes, 2);
  assert.equal(b.charts[0].options.length, 1);
  assert.equal(b.charts[0].disposed, 0);
  assert.equal(b.markdown.length, 1);
  button.emit("click");
  await settle();
  readyImage();
  await settle();
  assert.equal(
    b.printing.calls,
    2,
    "printing again after cancellation remains available",
  );
});

test("printing failure restores the button and browser print events resize existing charts", async () => {
  const b = browser();
  b.snapshot(doc);
  b.printing.fail = true;
  b.get("save-pdf").emit("click");
  await settle();
  assert.equal(b.get("save-pdf").disabled, false);
  b.printing.fail = false;
  b.get("save-pdf").emit("click");
  await settle();
  assert.equal(b.printing.calls, 2);
  b.window.emit("beforeprint");
  b.window.emit("afterprint");
  assert.equal(b.charts[0].resizes, 4);
});

test("shared content, screen chrome and print rules have separate stylesheet ownership", async () => {
  const [html, content, screen, print] = await Promise.all(
    ["client.html", "content.css", "client.css", "print.css"].map((name) =>
      readFile(new URL(`../web/${name}`, import.meta.url), "utf8"),
    ),
  );
  assert.match(html, /href="\/content\.css"\s*\/>/);
  assert.match(html, /href="\/client\.css" media="screen"/);
  assert.match(html, /href="\/theme\.css" media="screen"/);
  assert.match(html, /href="\/print\.css" media="print"/);
  assert.match(content, /\.block-content h1/);
  assert.match(content, /\.block-content table/);
  assert.doesNotMatch(
    content,
    /\.toolbar|\.outline|\.block-copy|\.block-select/,
  );
  assert.doesNotMatch(screen, /\.block-content h1|\.block-content table/);
  assert.match(print, /@page/);
  assert.match(print, /break-before:\s*page/);
  assert.match(print, /white-space:\s*pre-wrap/);
  assert.doesNotMatch(print, /font-family:/);
});
