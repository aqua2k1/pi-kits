import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { WebSocket } from "ws";
import { DocumentStore } from "../core/store.ts";
import { startCanvasNoteServer } from "../server/index.ts";

const chromium = process.env.CHROMIUM_PATH || "chromium";
const hasChromium = spawnSync(chromium, ["--version"]).status === 0;

type CommandResult = {
  data?: string;
  targetId?: string;
  sessionId?: string;
  result?: { value?: unknown };
  exceptionDetails?: unknown;
};

// Drive the actual installed browser through CDP; no DOM, parser, network or
// renderer mocks are involved in this test.
async function connectBrowser(endpoint: string) {
  const socket = new WebSocket(endpoint);
  await once(socket, "open");
  let nextId = 0;
  const pending = new Map<
    number,
    { resolve(value: CommandResult): void; reject(error: Error): void }
  >();
  const exceptions: unknown[] = [];
  const failures: unknown[] = [];
  socket.on("message", (raw) => {
    const message = JSON.parse(raw.toString());
    if (message.id) {
      const request = pending.get(message.id);
      pending.delete(message.id);
      if (message.error)
        request?.reject(new Error(JSON.stringify(message.error)));
      else request?.resolve(message.result);
    } else if (message.method === "Runtime.exceptionThrown") {
      exceptions.push(message.params.exceptionDetails);
    } else if (
      message.method === "Network.responseReceived" &&
      message.params.response.status >= 400
    ) {
      failures.push(message.params.response);
    }
  });
  socket.on("close", () => {
    for (const request of pending.values())
      request.reject(new Error("Browser disconnected"));
    pending.clear();
  });
  const send = (
    method: string,
    params: object = {},
    sessionId?: string,
  ): Promise<CommandResult> => {
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params, sessionId }));
    });
  };
  return { send, exceptions, failures, close: () => socket.close() };
}

async function until<T>(
  probe: () => Promise<T>,
  description: string,
): Promise<NonNullable<T>> {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const result = await probe();
    if (result) return result as NonNullable<T>;
    await delay(50);
  }
  throw new Error(`Timed out: ${description}`);
}

test("real Chromium renders semantic outlines, consumes updates and exports working offline navigation", {
  skip: !hasChromium,
  timeout: 90000,
}, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "canvas-outline-browser-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new DocumentStore(join(dir, "doc.json"));
  const { pageId } = await store.insertPage({ title: "Browser report" });
  const spacer = Array.from(
    { length: 35 },
    (_, i) => `Paragraph ${i}: browser navigation fixture.`,
  ).join("\n\n");
  const inserted = await store.insertBlocks({
    pageId,
    blocks: [
      {
        type: "text",
        title: "Logical block",
        spec: {
          md: `# **Repeated** [heading](https://example.com)\n\nFIRSTBLOCKSENTINEL\n\n${spacer}\n\n\`\`\`md\n# Fake code heading\n\`\`\`\n\n<h2>Raw HTML heading</h2>`,
        },
      },
      {
        type: "text",
        spec: {
          md: `### Repeated heading\n\nSECONDBLOCKSENTINEL\n\n${spacer}\n\nSecond\n======\n\n> #### Quoted heading`,
        },
      },
      {
        type: "chart",
        spec: {
          xAxis: { data: ["a", "b"] },
          yAxis: {},
          series: [{ type: "bar", data: [1, 2] }],
        },
      },
    ],
  });
  const { pageId: emptyPageId } = await store.insertPage({
    title: "Empty page",
  });
  const { pageId: excludedPageId } = await store.insertPage({
    title: "Excluded page",
  });
  const { blockIds: excludedBlockIds } = await store.insertBlocks({
    pageId: excludedPageId,
    blocks: [
      { type: "text", spec: { md: "EXCLUDEDPAGESENTINEL" } },
      { type: "text", spec: { md: "MIXEDBLOCKSENTINEL" } },
    ],
  });
  const [firstId, secondId, chartId] = inserted.blockIds;
  const errors: unknown[] = [];
  const server = await startCanvasNoteServer({
    host: "127.0.0.1",
    port: 0,
    store,
    onReply() {},
    onRenderError: (error) => {
      errors.push(error);
    },
    onError: (error) => errors.push(error),
  });
  t.after(() => server.close());
  const child = spawn(
    chromium,
    [
      "--headless",
      "--no-sandbox",
      "--disable-gpu",
      "--remote-debugging-port=0",
      `--user-data-dir=${join(dir, "profile")}`,
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill();
      await exited;
    }
  });
  const endpoint = await new Promise<string>((resolve, reject) => {
    let output = "";
    const timeout = setTimeout(
      () => reject(new Error(`Chromium startup timed out: ${output}`)),
      10000,
    );
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`Chromium exited ${code}: ${output}`));
    });
    child.stderr.on("data", (chunk) => {
      output += chunk.toString();
      const match = /DevTools listening on (ws:\/\/\S+)/.exec(output);
      if (match) {
        clearTimeout(timeout);
        resolve(match[1]);
      }
    });
  });
  const cdp = await connectBrowser(endpoint);
  t.after(() => cdp.close());
  const { targetId } = await cdp.send("Target.createTarget", {
    url: "about:blank",
  });
  const { sessionId } = await cdp.send("Target.attachToTarget", {
    targetId,
    flatten: true,
  });
  const send = (method: string, params: object = {}) =>
    cdp.send(method, params, sessionId);
  const evaluate = async <T = unknown>(expression: string): Promise<T> => {
    const result = await send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails)
      throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result?.value as T;
  };
  await send("Runtime.enable");
  await send("Page.enable");
  await send("Network.enable");
  await send("Emulation.setDeviceMetricsOverride", {
    width: 1280,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await cdp.send("Browser.setDownloadBehavior", {
    behavior: "allow",
    downloadPath: dir,
  });
  await send("Page.navigate", { url: server.url });
  await until(
    () =>
      evaluate(
        "document.getElementById('connection')?.textContent === 'Connected'",
      ),
    "actual client WebSocket snapshot",
  );
  assert.equal(
    await evaluate(`(() => {
    const page = document.querySelector('.page').getBoundingClientRect();
    const selection = document.querySelector('.page-selection').getBoundingClientRect();
    return selection.left - page.left < 30 && selection.top - page.top < 30;
  })()`),
    true,
  );
  const checkAllFolds = async () => {
    await evaluate("document.getElementById('outline-collapse-all').click()");
    assert.equal(
      await evaluate(
        "Array.from(document.querySelectorAll('#outline-list .outline-children')).every(node => node.hidden)",
      ),
      true,
    );
    assert.equal(
      await evaluate(
        "Array.from(document.querySelectorAll('#outline-list .outline-page-toggle')).every(node => node.getAttribute('aria-expanded') === 'false')",
      ),
      true,
    );
    await evaluate("document.getElementById('outline-expand-all').click()");
    assert.equal(
      await evaluate(
        "Array.from(document.querySelectorAll('#outline-list .outline-children')).every(node => !node.hidden)",
      ),
      true,
    );
    assert.equal(
      await evaluate(
        "Array.from(document.querySelectorAll('#outline-list .outline-page-toggle')).every(node => node.getAttribute('aria-expanded') === 'true')",
      ),
      true,
    );
  };
  await checkAllFolds();
  assert.deepEqual(
    await evaluate(
      "Array.from(document.querySelectorAll('#outline-mode button'), node => node.textContent)",
    ),
    ["Outline", "Structure"],
  );
  const originalDocument = await readFile(store.path, "utf8");
  await evaluate(`window.testChart = window.echarts.getInstanceByDom(document.querySelector('[data-block-id="${chartId}"] .block-content'));
    document.querySelector('[data-block-id="${firstId}"] .block-select').click();
    document.getElementById('outline-mode-semantic').click();`);
  await checkAllFolds();
  const labels = () =>
    evaluate<string[]>(
      "Array.from(document.querySelectorAll('.outline-heading > .outline-page-row > .outline-link'), node => node.textContent)",
    );
  assert.deepEqual(await labels(), [
    "Repeated heading",
    "Repeated heading",
    "Second",
    "Quoted heading",
  ]);
  assert.equal(
    await evaluate(
      "document.querySelectorAll('#outline-list > .outline-page').length",
    ),
    3,
  );
  assert.equal(
    await evaluate(
      "document.querySelectorAll('#outline-list > .outline-page:nth-child(2) .outline-heading').length",
    ),
    0,
  );
  assert.equal(
    await evaluate(
      "document.querySelectorAll('.outline-heading .outline-heading').length",
    ),
    2,
  );
  assert.equal(
    await evaluate(
      `document.querySelector('[data-block-id="${firstId}"] .block-select').checked`,
    ),
    true,
  );
  assert.equal(
    await evaluate(
      `window.testChart === window.echarts.getInstanceByDom(document.querySelector('[data-block-id="${chartId}"] .block-content'))`,
    ),
    true,
  );
  // Verify the real scroll target is visible below the sticky toolbar.
  await evaluate(
    "document.querySelectorAll('.outline-heading > .outline-page-row > .outline-link')[1].click()",
  );
  const position = await evaluate<{
    top: number;
    toolbarBottom: number;
    height: number;
  }>(`new Promise(resolve => {
    const target = document.getElementById('canvas-heading-${secondId}-0');
    let previous, stable = 0;
    const frame = () => {
      const top = target.getBoundingClientRect().top;
      stable = previous !== undefined && Math.abs(top - previous) < 0.1 ? stable + 1 : 0;
      previous = top;
      if (stable >= 12) resolve({ top, toolbarBottom: document.querySelector('.toolbar').getBoundingClientRect().bottom, height: innerHeight });
      else requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  })`);
  assert.ok(
    position.top >= position.toolbarBottom && position.top < position.height,
    `Heading is obscured after scroll settles: ${JSON.stringify(position)}`,
  );
  await evaluate(
    "document.querySelector('.outline-heading .outline-page-toggle').click(); document.getElementById('outline-mode-structure').click()",
  );
  assert.equal(
    await evaluate(
      "document.querySelector('.outline-block .outline-link').textContent",
    ),
    "Logical block",
  );
  await evaluate("document.getElementById('outline-mode-semantic').click()");
  assert.equal(
    await evaluate(
      "document.querySelector('.outline-heading > .outline-children').hidden",
    ),
    true,
  );
  assert.equal(await readFile(store.path, "utf8"), originalDocument);
  // Each click must produce a new completed download, not reuse an earlier file.
  const downloadHtml = async () => {
    // CDP's allow mode may overwrite identically named downloads. Isolate each
    // click so a completed file can never be mistaken for a previous export.
    const downloadDir = await mkdtemp(join(dir, "download-"));
    await cdp.send("Browser.setDownloadBehavior", {
      behavior: "allow",
      downloadPath: downloadDir,
    });
    const existing = new Set(await readdir(downloadDir));
    await evaluate(
      "document.getElementById('export-toggle').click(); document.getElementById('save-html').click()",
    );
    const filename = await until(
      async () =>
        (await readdir(downloadDir)).find(
          (name) => name.endsWith(".html") && !existing.has(name),
        ),
      "new actual HTML download",
    );
    await until(
      () => evaluate("!document.getElementById('save-html').disabled"),
      "HTML export controls restored",
    );
    const path = join(downloadDir, filename);
    return { filename: path, html: await readFile(path, "utf8") };
  };
  const select = async (pageIds: string[], blockIds: string[]) => {
    await evaluate(`(() => {
      for (const checkbox of document.querySelectorAll('.page-select:checked, .block-select:checked')) checkbox.click();
      for (const id of ${JSON.stringify(pageIds)}) document.querySelector('#pages .page[data-page-id="' + id + '"] .page-select').click();
      for (const id of ${JSON.stringify(blockIds)}) document.querySelector('#pages .block[data-block-id="' + id + '"] .block-select').click();
    })()`);
  };
  const liveState = () =>
    evaluate(`({
    pages: document.getElementById('pages').outerHTML,
    outline: document.getElementById('outline-list').outerHTML,
    checked: Array.from(document.querySelectorAll('.page-select, .block-select'), node => node.checked),
    chartUnchanged: window.testChart === window.echarts.getInstanceByDom(document.querySelector('[data-block-id="${chartId}"] .block-content'))
  })`);
  const checkExport = async (pageIds: string[], blockIds: string[]) => {
    const before = await liveState();
    const { html } = await downloadHtml();
    assert.deepEqual(
      await liveState(),
      before,
      "HTML export preserves online DOM and selections",
    );
    const parsed = await evaluate<{
      pageIds: string[];
      blockIds: string[];
      outlinePageIds: string[];
      invalidLinks: string[];
      inertLinks: number;
      charts: string[];
      promoted: boolean;
      text: string;
    }>(`(() => {
      const doc = new DOMParser().parseFromString(${JSON.stringify(html)}, 'text/html');
      return {
        pageIds: Array.from(doc.querySelectorAll('#pages .page'), node => node.dataset.pageId),
        blockIds: Array.from(doc.querySelectorAll('#pages .block'), node => node.dataset.blockId),
        outlinePageIds: Array.from(doc.querySelectorAll('#outline-list > .outline-page'), node => node.dataset.pageId),
        invalidLinks: Array.from(doc.querySelectorAll('a.outline-link')).filter(link => !doc.getElementById(decodeURIComponent(link.hash.slice(1)))).map(link => link.getAttribute('href')),
        inertLinks: doc.querySelectorAll('button.outline-link').length,
        charts: Array.from(doc.querySelectorAll('[data-export-chart]'), node => node.dataset.exportChart),
        promoted: !!doc.querySelector('.outline-page > .outline-children > .outline-heading > .outline-page-row > a[href="#canvas-heading-${secondId}-0"]'),
        text: doc.getElementById('pages').textContent
      };
    })()`);
    assert.deepEqual(parsed.pageIds, pageIds);
    assert.deepEqual(parsed.blockIds, blockIds);
    assert.deepEqual(parsed.outlinePageIds, pageIds);
    assert.deepEqual(parsed.invalidLinks, []);
    assert.equal(parsed.inertLinks, 0);
    assert.deepEqual(
      parsed.charts,
      blockIds.includes(chartId) ? [chartId] : [],
    );
    assert.doesNotMatch(parsed.text, /EXCLUDEDPAGESENTINEL/);
    if (!blockIds.includes(chartId))
      assert.doesNotMatch(html, /"charts":\[\{"id":/);
    return parsed;
  };

  await select([], [secondId]);
  const partial = await checkExport([pageId], [secondId]);
  assert.equal(
    partial.promoted,
    true,
    "child of an excluded heading is promoted to page level",
  );
  assert.match(partial.text, /SECONDBLOCKSENTINEL/);
  assert.doesNotMatch(partial.text, /FIRSTBLOCKSENTINEL/);

  // CDP runs Chromium's actual print lifecycle and print CSS, without a dialog.
  await evaluate(`window.printEvents = [];
    window.addEventListener('beforeprint', () => window.printEvents.push({
      type: 'before', selected: document.getElementById('pages').classList.contains('printing-selection'),
      pages: Array.from(document.querySelectorAll('#pages > .page.export-included'), node => node.dataset.pageId),
      blocks: Array.from(document.querySelectorAll('#pages .block.export-included'), node => node.dataset.blockId)
    }));
    window.addEventListener('afterprint', () => window.printEvents.push({
      type: 'after', markers: document.querySelectorAll('.printing-selection, .export-included, .export-first-page').length
    }));`);
  const checkedBeforePrint = await evaluate(
    "Array.from(document.querySelectorAll('.page-select, .block-select'), node => node.checked)",
  );
  const pdf = await send("Page.printToPDF", { printBackground: true });
  assert.ok(pdf.data, "Chromium generated a PDF");
  const pdfBytes = Buffer.from(pdf.data, "base64");
  assert.equal(pdfBytes.subarray(0, 5).toString(), "%PDF-");
  assert.deepEqual(await evaluate("window.printEvents"), [
    { type: "before", selected: true, pages: [pageId], blocks: [secondId] },
    { type: "after", markers: 0 },
  ]);
  assert.deepEqual(
    await evaluate(
      "Array.from(document.querySelectorAll('.page-select, .block-select'), node => node.checked)",
    ),
    checkedBeforePrint,
  );
  assert.equal(
    await evaluate(
      `window.testChart === window.echarts.getInstanceByDom(document.querySelector('[data-block-id="${chartId}"] .block-content'))`,
    ),
    true,
  );
  if (spawnSync("pdftotext", ["-v"]).status === 0) {
    const extracted = spawnSync("pdftotext", ["-", "-"], {
      input: pdfBytes,
      encoding: "utf8",
    });
    assert.equal(extracted.status, 0, extracted.stderr);
    assert.match(extracted.stdout, /SECONDBLOCKSENTINEL/);
    assert.doesNotMatch(
      extracted.stdout,
      /FIRSTBLOCKSENTINEL|EXCLUDEDPAGESENTINEL|MIXEDBLOCKSENTINEL|Empty page|Excluded page/,
    );
  } else {
    t.diagnostic(
      "pdftotext unavailable; generated PDF but skipped text assertions",
    );
  }

  await select([emptyPageId], []);
  await checkExport([emptyPageId], []);
  // Reverse selection order and overlap a whole page with one of its blocks.
  await select([emptyPageId, pageId], [excludedBlockIds[1], secondId]);
  const mixed = await checkExport(
    [pageId, emptyPageId, excludedPageId],
    [firstId, secondId, chartId, excludedBlockIds[1]],
  );
  assert.match(mixed.text, /FIRSTBLOCKSENTINEL/);
  assert.match(mixed.text, /SECONDBLOCKSENTINEL/);
  assert.match(mixed.text, /MIXEDBLOCKSENTINEL/);
  await select([], []);
  // Restore the original selection: its later deletion must leave an all-export.
  await select([], [firstId]);
  await evaluate(
    `window.oldHeading = document.getElementById('canvas-heading-${firstId}-0')`,
  );
  await store.updateBlocks({
    blocks: [
      { blockId: firstId, spec: { md: `## Revised heading\n\n${spacer}` } },
    ],
  });
  await until(
    async () => (await labels())[0] === "Revised heading",
    "incremental heading update",
  );
  assert.equal(
    await evaluate(
      `!window.oldHeading.isConnected && document.getElementById('canvas-heading-${firstId}-0') !== window.oldHeading`,
    ),
    true,
  );
  await store.updateBlocks({ blocks: [{ blockId: firstId, type: null }] });
  await until(
    async () => (await labels()).length === 3,
    "deleted heading removal and reparenting",
  );
  assert.deepEqual(await labels(), [
    "Repeated heading",
    "Second",
    "Quoted heading",
  ]);
  await evaluate(
    "document.querySelector('.outline-heading > .outline-page-row > .outline-link').click()",
  );
  await until(
    () =>
      evaluate(
        `document.getElementById('canvas-heading-${secondId}-0').getBoundingClientRect().top < innerHeight`,
      ),
    "surviving heading target",
  );
  // Use the real UI download path and the real DOM produced above.
  assert.equal(
    await evaluate(
      "document.querySelectorAll('.page-select:checked, .block-select:checked').length",
    ),
    0,
  );
  const { filename, html: exported } = await downloadHtml();
  const allIds = await evaluate(`(() => {
    const doc = new DOMParser().parseFromString(${JSON.stringify(exported)}, 'text/html');
    return {
      pages: Array.from(doc.querySelectorAll('#pages .page'), node => node.dataset.pageId),
      blocks: Array.from(doc.querySelectorAll('#pages .block'), node => node.dataset.blockId)
    };
  })()`);
  assert.deepEqual(allIds, {
    pages: [pageId, emptyPageId, excludedPageId],
    blocks: [secondId, chartId, ...excludedBlockIds],
  });
  assert.match(exported, /EXCLUDEDPAGESENTINEL/);
  assert.match(exported, new RegExp(`href="#canvas-heading-${secondId}-0"`));
  assert.doesNotMatch(exported, /id="outline-mode"|new WebSocket/);
  assert.deepEqual(errors, []);
  assert.deepEqual(cdp.exceptions, []);
  assert.deepEqual(cdp.failures, []);
  // Close the live page/server, then deny network in the same real browser.
  await send("Page.navigate", { url: "about:blank" });
  await server.close();
  await send("Network.emulateNetworkConditions", {
    offline: true,
    latency: 0,
    downloadThroughput: 0,
    uploadThroughput: 0,
  });
  await send("Page.navigate", { url: pathToFileURL(filename).href });
  await until(
    () =>
      evaluate(
        "document.querySelectorAll('a.outline-link').length > 0 && !!document.querySelector('[data-export-chart] canvas')",
      ),
    "offline exported document and chart",
  );
  assert.deepEqual(await labels(), [
    "Repeated heading",
    "Second",
    "Quoted heading",
  ]);
  assert.equal(
    await evaluate("document.getElementById('outline-mode') === null"),
    true,
  );
  await checkAllFolds();
  const offlineTargets = await evaluate<boolean[]>(
    "Array.from(document.querySelectorAll('a.outline-link'), link => !!document.getElementById(decodeURIComponent(link.hash.slice(1))))",
  );
  assert.ok(offlineTargets.length > 3);
  assert.ok(offlineTargets.every(Boolean));
  await evaluate(`window.offlineBranch = Array.from(document.querySelectorAll('.outline-heading')).find(node => node.querySelector(':scope > .outline-children').children.length);
    window.offlineBranch.querySelector(':scope > .outline-page-row > .outline-page-toggle').click()`);
  assert.equal(
    await evaluate(
      "window.offlineBranch.querySelector(':scope > .outline-children').hidden",
    ),
    true,
  );
  assert.equal(
    await evaluate(
      "document.querySelector('.outline-page > .outline-children').hidden",
    ),
    false,
  );
  assert.deepEqual(
    await evaluate(
      "window.echarts.getInstanceByDom(document.querySelector('[data-export-chart]')).getOption().series[0].data",
    ),
    [1, 2],
  );
  await evaluate(
    "window.offlineBranch.querySelector(':scope > .outline-page-row > .outline-page-toggle').click(); document.querySelector('.outline-heading a').click()",
  );
  await until(
    () => evaluate(`location.hash === '#canvas-heading-${secondId}-0'`),
    "offline heading anchor navigation",
  );
  assert.deepEqual(cdp.exceptions, []);
  assert.deepEqual(cdp.failures, []);
});
