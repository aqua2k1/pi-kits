import assert from "node:assert/strict";
import { execFile, spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setImmediate as settle } from "node:timers/promises";
import { promisify } from "node:util";
import { browser } from "./fixtures/browser.ts";

const run = promisify(execFile);
const require = createRequire(import.meta.url);
const chromium = process.env.CHROMIUM_PATH || "chromium";
const hasChromium = spawnSync(chromium, ["--version"]).status === 0;

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

test("standalone HTML embeds resources and restores interactive charts in a real browser", {
  skip: !hasChromium,
  timeout: 60000,
}, async () => {
  const dir = await mkdtemp(join(tmpdir(), "canvas-export-"));
  const files: Record<string, [string, string | Buffer]> = {
    "/export-html.js": [
      "text/javascript",
      await readFile(new URL("../web/export-html.js", import.meta.url), "utf8"),
    ],
    "/vendor/echarts.js": [
      "text/javascript",
      await readFile(require.resolve("echarts/dist/echarts.min.js")),
    ],
    "/vendor/katex.js": [
      "text/javascript",
      await readFile(require.resolve("katex/dist/katex.min.js")),
    ],
    "/vendor/marked.js": [
      "text/javascript",
      await readFile(join(require.resolve("marked"), "../marked.umd.js")),
    ],
    "/vendor/marked-katex.js": [
      "text/javascript",
      await readFile(
        join(require.resolve("marked-katex-extension"), "../index.umd.js"),
      ),
    ],
    "/vendor/purify.js": [
      "text/javascript",
      await readFile(require.resolve("dompurify/dist/purify.min.js")),
    ],
    "/client.css": [
      "text/css",
      await readFile(new URL("../web/client.css", import.meta.url), "utf8"),
    ],
    "/content.css": [
      "text/css",
      await readFile(new URL("../web/content.css", import.meta.url), "utf8"),
    ],
    "/style.css": [
      "text/css",
      '@font-face { font-family: test; src: url("/font.woff2"); } .content-chart { height: 300px; }',
    ],
    "/font.woff2": ["font/woff2", "font fixture"],
    "/image.svg": [
      "image/svg+xml",
      '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><rect width="2" height="2"/></svg>',
    ],
  };
  const fixture = `<!doctype html><html><head><link rel="stylesheet" href="/content.css"><link rel="stylesheet" href="/client.css"><link rel="stylesheet" href="/style.css">
    <script defer src="/vendor/katex.js"></script>
    <script defer src="/vendor/marked.js"></script>
    <script defer src="/vendor/marked-katex.js"></script>
    <script defer src="/vendor/purify.js"></script>
    </head><body>
    <aside id="outline" class="outline collapsed" aria-label="Document outline">
      <div class="outline-header"><span class="outline-title">Contents</span><button id="outline-toggle" aria-controls="outline-tree" aria-expanded="false">›</button></div>
      <nav id="outline-tree" hidden><ul class="outline-list"><li class="outline-page" data-page-id="p"><div class="outline-page-row"><button class="outline-page-toggle" aria-expanded="true">▾</button><button class="outline-link outline-page-link">Export</button></div><ul class="outline-children"><li class="outline-block" data-block-id="chart"><button class="outline-link outline-block-link">Chart</button></li></ul></li></ul></nav>
    </aside>
    <main id="pages" class="outline-collapsed"><h2 id="canvas-heading-chart-0" data-outline-heading="0">Repeated heading</h2><h3 id="canvas-heading-chart-1" data-outline-heading="1">Repeated heading</h3><section class="page selected" data-page-id="p"><h1>Export</h1><label class="page-selection"><input type="checkbox" class="page-select" checked>Select page</label>
    <div class="block selected" data-block-id="chart"><input class="block-select"><div class="block-content content-chart"><canvas></canvas></div><button class="block-copy">Copy</button></div>
    <p><code>&lt;script&gt;not executable&lt;/script&gt;</code><img src="/image.svg" srcset="/image.svg 2x"></p></section></main>
    <script type="module">
      import { buildHtml } from '/export-html.js';
      const pages = document.getElementById('pages');
      const formula = document.createElement('p');
      formula.innerHTML = DOMPurify.sanitize(new marked.Marked(markedKatex({ nonStandard: true, trust: false, throwOnError: true })).parse('能量$E=mc^2$满足关系。'));
      pages.append(formula);
      if (!formula.querySelector('.katex')) throw new Error('Inline math was not rendered');
      const outline = document.getElementById('outline');
      const headingItem = document.createElement('li');
      headingItem.className = 'outline-heading';
      headingItem.innerHTML = '<div class="outline-page-row"><button class="outline-page-toggle" aria-expanded="true">▾</button><button class="outline-link outline-block-link" data-target-id="canvas-heading-chart-0">Repeated heading</button></div><ul class="outline-children"><li class="outline-heading"><div class="outline-page-row"><button class="outline-link outline-block-link" data-target-id="canvas-heading-chart-1">Repeated heading</button></div></li></ul>';
      outline.querySelector('.outline-children').append(headingItem);
      const before = pages.outerHTML + outline.outerHTML;
      try {
        const html = await buildHtml({ title: 'Export <test>', pages, outline, theme: {}, charts: [{ id: 'chart', option: {
          title: { text: '<' + '/script><script>window.injected=true<' + '/script>' },
          tooltip: {}, xAxis: { data: ['a'] }, yAxis: {}, series: [{ type: 'bar', data: [3] }]
        }}] });
        if (before !== pages.outerHTML + outline.outerHTML) throw new Error('Live DOM changed');
        const noCharts = await buildHtml({ title: 'Text only', pages, outline, theme: {}, charts: [] });
        if (noCharts.includes('echarts.min.js')) throw new Error('Unnecessary chart library');
        const textOnly = new DOMParser().parseFromString(noCharts, 'text/html');
        if (!textOnly.querySelector('#outline') || !textOnly.querySelector('script')) throw new Error('Text-only outline missing');
        await fetch('/result', { method: 'POST', body: html });
      } catch (error) { await fetch('/failure', { method: 'POST', body: String(error) }); }
    </script></body></html>`;
  const result = Promise.withResolvers<string>();
  const server = createServer(async (req, res) => {
    if (req.url === "/result" || req.url === "/failure") {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks).toString("utf8");
      res.end("ok");
      if (req.url === "/result") result.resolve(body);
      else result.reject(new Error(body));
      return;
    }
    const item =
      req.url === "/" ? ["text/html", fixture] : files[req.url || ""];
    if (!item) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.setHeader("Content-Type", item[0]);
    res.end(item[1]);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const flags = ["--headless", "--no-sandbox", "--disable-gpu"];
  const child = spawn(
    chromium,
    [
      ...flags,
      `--user-data-dir=${join(dir, "online")}`,
      `http://127.0.0.1:${address.port}/`,
    ],
    { stdio: "ignore" },
  );
  child.once("error", result.reject);
  const deadline = setTimeout(
    () => result.reject(new Error("Browser export timed out")),
    25000,
  );
  try {
    const html = await result.promise;
    child.kill();
    assert.doesNotMatch(
      html,
      /<link|<script[^>]+src=|<img[^>]+srcset=|class="block-select"|class="block-copy"|class="block selected"|class="page selected"|class="page-selection"|class="page-select"|new WebSocket/,
    );
    assert.match(html, /data:font\/woff2;base64,/);
    assert.match(html, /data:image\/svg\+xml;base64,/);
    assert.match(html, /\\u003c\/script>/);
    assert.match(html, /class="katex"/);
    // Close the HTTP server before opening the downloaded file.
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const file = join(dir, "export.html");
    const checks = `<script>
      try {
        const outline = document.getElementById('outline');
        const toggle = document.getElementById('outline-toggle');
        const pages = document.getElementById('pages');
        if (!outline.classList.contains('collapsed') || !pages.classList.contains('outline-collapsed')) throw new Error('Initial collapse lost');
        toggle.click();
        if (outline.classList.contains('collapsed') || document.getElementById('outline-tree').hidden || toggle.getAttribute('aria-expanded') !== 'true') throw new Error('Expand failed');
        const pageToggle = outline.querySelector('.outline-page-toggle');
        pageToggle.click();
        if (!outline.querySelector('.outline-children').hidden || pageToggle.getAttribute('aria-expanded') !== 'false') throw new Error('Page collapse failed');
        pageToggle.click();
        if (outline.querySelector('.outline-children').hidden) throw new Error('Page expand failed');
        const headingToggle = outline.querySelector('.outline-heading .outline-page-toggle');
        headingToggle.click();
        if (!headingToggle.closest('li').querySelector('.outline-children').hidden) throw new Error('Heading collapse failed');
        if (outline.querySelector('.outline-children').hidden) throw new Error('Heading collapse affected page');
        headingToggle.click();
        for (const link of outline.querySelectorAll('a.outline-link')) {
          link.click();
          if (!document.getElementById(decodeURIComponent(location.hash.slice(1)))) throw new Error('Broken navigation');
        }
        toggle.click();
        if (!pages.classList.contains('outline-collapsed')) throw new Error('Collapse failed');
        document.body.dataset.outlineTest = 'passed';
      } catch (error) { document.body.dataset.outlineTest = String(error); }
    </script>`;
    await writeFile(
      file,
      html.replace(/<\/body><\/html>$/, `${checks}</body></html>`),
    );
    const offline = await run(
      chromium,
      [
        ...flags,
        `--user-data-dir=${join(dir, "offline")}`,
        "--dump-dom",
        "--virtual-time-budget=2000",
        `file://${file}`,
      ],
      {
        maxBuffer: 20 * 1024 * 1024,
      },
    );
    assert.match(offline.stdout, /<canvas[^>]+width=/);
    assert.match(offline.stdout, /_echarts_instance_=/);
    assert.match(offline.stdout, /data-outline-test="passed"/);
    assert.match(html, /href="#canvas-page-p"/);
    assert.match(html, /href="#canvas-block-chart"/);
    assert.match(html, /href="#canvas-heading-chart-0"/);
    assert.match(html, /href="#canvas-heading-chart-1"/);
    assert.match(offline.stdout, /class="katex"/);
    assert.doesNotMatch(
      offline.stdout,
      /<script>window.injected=true<\/script>/,
    );
  } finally {
    clearTimeout(deadline);
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>((resolve) =>
        child.once("exit", () => resolve()),
      );
      child.kill();
      await exited;
    }
    server.closeAllConnections();
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
