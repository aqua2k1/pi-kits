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
const {
  renderMarkdown,
  renderTableMarkdown,
  tableToMarkdown,
  tableCellToMarkdown,
} = runInNewContext(
  `${source.slice(0, boundary)}\n ({ renderMarkdown, renderTableMarkdown, tableToMarkdown, tableCellToMarkdown });\n}`,
  {
    ...clientGlobals,
    window: {
      marked: { Marked },
      markedKatex,
      katex,
    },
  },
) as {
  renderMarkdown: (md: string) => string;
  renderTableMarkdown: (spec: {
    columns: string[];
    rows: unknown[][];
  }) => string;
  tableToMarkdown: (spec: { columns: string[]; rows: unknown[][] }) => string;
  tableCellToMarkdown: (text: string) => string;
};

test("table cells render inline Markdown and formulas with isolated cell scope", () => {
  for (const [input, pattern] of [
    ["$A_t$", /class="katex"/],
    ["**符号**", /<strong>符号<\/strong>/],
    ["[链接](https://example.com)", /<a href="https:\/\/example.com">/],
    ["`$A_t$`", /<code>\$A_t\$<\/code>/],
    ["# 标题", /># 标题<\/td>/],
    ["$A", />\$A<\/td>/],
    ["t$", />t\$<\/td>/],
  ] as const) {
    const html = renderTableMarkdown({
      columns: ["**符号**"],
      rows: [[input]],
    });
    assert.match(html, pattern);
    assert.match(html, /<th scope="col"><strong>符号<\/strong><\/th>/);
    assert.doesNotMatch(html, /<p>|<h[1-6]/);
  }
});

test("table text escaping handles pipes and all newline styles without changing Markdown", () => {
  assert.equal(
    tableCellToMarkdown("A | B\r\n**bold**\r$A_t$\nend"),
    "A \\| B<br>**bold**<br>$A_t$<br>end",
  );
  assert.equal(tableCellToMarkdown("A | B"), "A \\| B");
  const html = renderTableMarkdown({
    columns: ["A | B"],
    rows: [["x | y\nz"]],
  });
  assert.match(html, /<th scope="col">A \| B<\/th>/);
  assert.match(html, /<td>x \| y<br>z<\/td>/);
  assert.equal((html.match(/<td>/g) ?? []).length, 1);
});

test("table serialization converts values without mutating input", () => {
  const spec = {
    columns: ["Value"],
    rows: [[42], [false], [null], [{ a: 1 }], [[1, 2]]],
  };
  const before = JSON.stringify(spec);
  assert.equal(
    tableToMarkdown(spec),
    '| Value |\n| --- |\n| 42 |\n| false |\n|  |\n| {"a":1} |\n| [1,2] |',
  );
  assert.equal(JSON.stringify(spec), before);
  const html = renderTableMarkdown(spec);
  assert.match(html, /<td>42<\/td>/);
  assert.match(html, /<td>false<\/td>/);
  assert.match(html, /<td><\/td>/);
});

test("table rendering preserves empty and uneven row shapes", () => {
  for (const spec of [
    { columns: [], rows: [] },
    { columns: [], rows: [["a", "b"]] },
    { columns: ["A", "B"], rows: [["a"], [], ["a", "b", "c"]] },
  ]) {
    const html = renderTableMarkdown(spec);
    assert.equal((html.match(/<th scope=/g) ?? []).length, spec.columns.length);
    const bodies = [...html.matchAll(/<tr>\n([\s\S]*?)<\/tr>/g)].slice(1);
    assert.deepEqual(
      bodies.map((row) => (row[1].match(/<td>/g) ?? []).length),
      spec.rows.map((row) => row.length),
    );
  }
});

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
