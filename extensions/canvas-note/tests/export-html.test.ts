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
  const fixture = `<!doctype html><html><head><link rel="stylesheet" href="/style.css"></head><body>
    <main id="pages" class="outline-collapsed"><section class="page"><h1>Export</h1>
    <div class="block selected" data-block-id="chart"><input class="block-select"><div class="block-content content-chart"><canvas></canvas></div><button class="block-copy">Copy</button></div>
    <p><code>&lt;script&gt;not executable&lt;/script&gt;</code><img src="/image.svg" srcset="/image.svg 2x"></p></section></main>
    <script type="module">
      import { buildHtml } from '/export-html.js';
      const pages = document.getElementById('pages');
      const before = pages.outerHTML;
      try {
        const html = await buildHtml({ title: 'Export <test>', pages, theme: {}, charts: [{ id: 'chart', option: {
          title: { text: '<' + '/script><script>window.injected=true<' + '/script>' },
          tooltip: {}, xAxis: { data: ['a'] }, yAxis: {}, series: [{ type: 'bar', data: [3] }]
        }}] });
        if (before !== pages.outerHTML) throw new Error('Live DOM changed');
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
      /<link|<script[^>]+src=|<img[^>]+srcset=|class="block-select"|class="block-copy"|class="block selected"|new WebSocket/,
    );
    assert.match(html, /data:font\/woff2;base64,/);
    assert.match(html, /data:image\/svg\+xml;base64,/);
    assert.match(html, /\\u003c\/script>/);
    // Close the HTTP server before opening the downloaded file.
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const file = join(dir, "export.html");
    await writeFile(file, html);
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
