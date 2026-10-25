import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { DocumentStore } from "../core/model.ts";
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
  const { blockIds } = await store.insert({
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
  await store.update({
    blocks: [{ blockId: blockIds[0], spec: { latex: String.raw`\frac{1}{` } }],
  });
  await store.update({
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
