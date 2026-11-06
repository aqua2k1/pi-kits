import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { setImmediate as settle } from "node:timers/promises";
import { bundleModules } from "../web/export-html.js";
import { browser } from "./fixtures/browser.ts";

test("export menu repositions on opening, viewport resize and toolbar scrolling", () => {
  const b = browser();
  let right = 500;
  const menu = Object.assign(b.get("export-menu"), {
    matches: () => true,
    getBoundingClientRect: () => ({ width: 160, height: 100 }),
  });
  Object.assign(b.get("export-toggle"), {
    getBoundingClientRect: () => ({ right, top: 20, bottom: 60 }),
  });
  Object.assign(b.window, { innerWidth: 800, innerHeight: 600 });
  menu.emit("toggle");
  assert.equal(menu.style.left, "340px");
  assert.equal(menu.style.top, "66px");
  right = 200;
  b.window.emit("scroll");
  assert.equal(menu.style.left, "40px");
  right = 500;
  Object.assign(b.window, { innerWidth: 320 });
  b.window.emit("resize");
  assert.equal(menu.style.left, "152px");
});

test("HTML export controls recover after failure without affecting PDF or selection", async () => {
  const b = browser();
  assert.equal(b.get("save-html").disabled, true);
  b.snapshot({
    version: 1,
    pages: [
      {
        id: "p",
        title: "Export",
        blocks: [
          { id: "text", type: "text", align: "left", spec: { md: "Hello" } },
        ],
      },
    ],
  });
  const checkbox = b.block("text").children[0];
  checkbox.checked = true;
  checkbox.emit("change");
  const button = b.get("save-html");
  assert.equal(button.disabled, false);
  button.emit("click");
  assert.equal(button.disabled, true);
  assert.equal(b.get("save-pdf").disabled, true);
  await settle();
  assert.match(b.get("export-status").textContent, /Export failed:/);
  assert.equal(button.disabled, false);
  assert.equal(b.get("save-pdf").disabled, false);
  assert.equal(checkbox.checked, true);
});

const decode = (value: string) =>
  Buffer.from(value.slice(value.indexOf(",") + 1), "base64").toString("utf8");

test("module export rewrites actual shared ESM imports and preserves Unicode source", async () => {
  const calls: string[] = [];
  const sources: Record<string, string> = {
    "https://canvas.test/client.js":
      'import { render } from "./view.js";\nimport { other } from "./other.js";\nrender("标题");',
    "https://canvas.test/view.js":
      'import { value } from "./core/value.js";\nexport function render(text) { return text + value; }',
    "https://canvas.test/other.js":
      'export { value as other } from "./core/value.js";',
    "https://canvas.test/core/value.js": 'export const value = "数据";',
  };
  const bundle = await bundleModules(
    "https://canvas.test/client.js",
    async (url: string) => {
      calls.push(url);
      assert.ok(Object.hasOwn(sources, url), url);
      return sources[url];
    },
  );
  assert.equal(bundle.entry, "canvas-note/client.js");
  assert.equal(Object.keys(bundle.imports).length, 4);
  assert.equal(calls.filter((url) => url.endsWith("/core/value.js")).length, 1);
  assert.match(
    decode(bundle.imports[bundle.entry]),
    /from "canvas-note\/view.js"/,
  );
  assert.match(decode(bundle.imports[bundle.entry]), /标题/);
  assert.match(decode(bundle.imports["canvas-note/core/value.js"]), /数据/);
  assert.match(
    decode(bundle.imports["canvas-note/other.js"]),
    /from "canvas-note\/core\/value.js"/,
  );
});

test("the actual browser module graph is embedded without unresolved relative imports", async () => {
  const bundle = await bundleModules(
    "https://canvas.test/client.js",
    async (url: string) => {
      const path = new URL(url).pathname;
      return readFile(
        new URL(
          `..${path.startsWith("/core/") ? path : `/web${path}`}`,
          import.meta.url,
        ),
        "utf8",
      );
    },
  );
  assert.ok(bundle.imports["canvas-note/document-view.js"]);
  assert.ok(bundle.imports["canvas-note/online-controller.js"]);
  assert.ok(bundle.imports["canvas-note/core/contracts.js"]);
  for (const value of Object.values(bundle.imports)) {
    const source = decode(value);
    assert.doesNotMatch(source, /\bfrom\s+["']\.\.?\//);
  }
});
