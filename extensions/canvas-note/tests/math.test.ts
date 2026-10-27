import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { Marked } from "marked";
import markedKatex from "marked-katex-extension";
import { DocumentStore } from "../core/store.ts";
import { clientGlobals, clientScript } from "./fixtures/client-script.ts";
import { complexFormulas } from "./fixtures/math.ts";

const require = createRequire(import.meta.url);
const katex = require("katex") as {
  renderToString: (latex: string, options: Record<string, unknown>) => string;
};
const options = {
  displayMode: true,
  throwOnError: true,
  trust: false,
  strict: "error",
};

const source = clientScript(
  readFileSync(new URL("../web/document-view.js", import.meta.url), "utf8"),
);
const boundary = source.indexOf("\n  // Shared local rendering");
assert.ok(boundary > 0);
const renderMarkdown = runInNewContext(
  `${source.slice(0, boundary)}\n globalThis.renderMarkdown = renderMarkdown;\n}`,
  { ...clientGlobals, window: { marked: { Marked }, markedKatex, katex } },
) as (md: string) => string;

for (const [name, md, display] of [
  ["dollar inline", "能量$E=mc^2$满足关系。", false],
  ["display dollars", "$$\n\\sum_{i=1}^n i\n$$", true],
  ["inline display", "结果$$x^2$$。", true],
  ["inline within emphasis", "**结果 $x_i^2$**", false],
  ["inline within table", "| 值 |\n|---|\n| $x^2$ |", false],
] as const) {
  test(`Markdown renders ${name}`, () => {
    const html = renderMarkdown(md);
    assert.match(html, /class="katex"/);
    assert.equal(html.includes('class="katex-display"'), display);
    assert.doesNotMatch(html, /class="katex-error"/);
  });
}

test("Markdown keeps code, escaped dollars and unclosed delimiters literal", () => {
  for (const md of [
    "`$x$`",
    "```latex\n$x$\n```",
    "    $x$\n",
    String.raw`\$x\$`,
    String.raw`价格 \$5 和 \$10。`,
    "Unclosed $x",
  ])
    assert.doesNotMatch(renderMarkdown(md), /class="katex"/, md);
});

test("Markdown preserves LaTeX escapes and renders multiple formulas without changing global Marked", () => {
  const html = renderMarkdown(
    String.raw`$\frac{a_1}{b^2}$ 和 $\text{cost: \$5}$`,
  );
  assert.equal((html.match(/class="katex"/g) || []).length, 2);
  assert.match(new Marked().parse("$x$") as string, /\$x\$/);
  assert.throws(
    () => renderMarkdown(String.raw`$\unknownCanvasCommand{x}$`),
    /KaTeX parse error/,
  );
  const safe = renderMarkdown(String.raw`$\href{javascript:alert(1)}{click}$`);
  assert.doesNotMatch(safe, /href="javascript:/);
});

for (const formula of complexFormulas) {
  test(`complex formula: ${formula.name}`, () => {
    const html = katex.renderToString(formula.latex, options);
    assert.match(html, /class="katex"/);
    assert.match(html, /<math/);
    assert.doesNotMatch(html, /class="katex-error"/);
  });
}

test("invalid and unsupported formulas fail explicitly rather than silently rendering", () => {
  for (const latex of [
    String.raw`\frac{1}{`,
    String.raw`\unknownCanvasCommand{x}`,
    String.raw`\begin{tikzpicture}\draw (0,0)--(1,1);\end{tikzpicture}`,
  ]) {
    assert.throws(
      () => katex.renderToString(latex, options),
      /KaTeX parse error/,
    );
  }
});

test("formula JSON preserves LaTeX escapes and supports correcting malformed content", async (t) => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "canvas-note-math-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new DocumentStore(join(dir, "doc.json"));
  const { blockIds } = await store.insertBlocks({
    blocks: complexFormulas.map((formula) => ({
      type: "math",
      spec: { latex: formula.latex },
    })),
  });
  const doc = await store.read();
  assert.deepEqual(
    doc.pages[0].blocks.map((block) => block.spec.latex),
    complexFormulas.map((formula) => formula.latex),
  );
  await store.updateBlocks({
    blocks: [{ blockId: blockIds[0], spec: { latex: String.raw`\frac{1}{` } }],
  });
  await store.updateBlocks({
    blocks: [
      { blockId: blockIds[0], spec: { latex: complexFormulas[0].latex } },
    ],
  });
  const corrected = (await store.read()).pages[0].blocks[0];
  assert.equal(corrected.id, blockIds[0]);
  assert.doesNotThrow(() =>
    katex.renderToString(String(corrected.spec.latex), options),
  );
});
