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
import { complexFormulas } from "./fixtures/math.ts";

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
  const requests: { sessionId: string; url: string }[] = [];
  socket.on("message", (raw) => {
    const message = JSON.parse(raw.toString());
    if (message.id) {
      const request = pending.get(message.id);
      pending.delete(message.id);
      if (message.error)
        request?.reject(new Error(JSON.stringify(message.error)));
      else request?.resolve(message.result);
    } else if (message.method === "Network.requestWillBeSent") {
      requests.push({
        sessionId: message.sessionId,
        url: message.params.request.url,
      });
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
  return { send, exceptions, failures, requests, close: () => socket.close() };
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
          md: `### Repeated heading\n\nSECONDBLOCKSENTINEL\n\n![Embedded](/favicon.svg?x=1&amp;y=2)\n\n<picture><source srcset="/favicon.svg?variant=source"><img src="/favicon.svg?variant=fallback" srcset="/favicon.svg?variant=other 2x"></picture>\n\n${spacer}\n\nSecond\n======\n\n> #### Quoted heading`,
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
  const hostile = "</script><script>window.exportInjection = true</script>";
  const wideColumns = Array.from({ length: 40 }, (_, i) => `Column ${i}`);
  const wideRow = wideColumns.map(() => "unbreakable-cell-value");
  const { blockIds: excludedBlockIds } = await store.insertBlocks({
    pageId: excludedPageId,
    blocks: [
      { type: "text", spec: { md: "EXCLUDEDPAGESENTINEL" } },
      { type: "text", spec: { md: "MIXEDBLOCKSENTINEL" } },
      {
        type: "code",
        spec: {
          language: "javascript",
          code: `const hostile = ${JSON.stringify(hostile)};`,
        },
      },
      { type: "math", spec: { latex: "x^2 + y^2 = z^2" } },
      {
        type: "text",
        spec: {
          md: "| Name | Value |\n| --- | --- |\n| Offline | 42 |\n\nInline math $a^2$.",
        },
      },
      {
        type: "text",
        spec: {
          md: String.raw`行内公式 $A_t$。大字号行内公式 $\Huge\frac{a_1^2}{b_2^3}$。`,
        },
      },
      {
        type: "text",
        spec: { md: `$$\n${String.raw`\Huge\frac{a_1^2}{b_2^3}`}\n$$` },
      },
      ...complexFormulas.map(({ latex }) => ({
        type: "text" as const,
        spec: { md: `$$\n${latex}\n$$` },
      })),
      {
        type: "text",
        spec: {
          md: `\`\`\`text\n${"wide-code ".repeat(100)}\n\`\`\`\n\n| ${wideColumns.join(" | ")} |\n| ${wideColumns.map(() => "---").join(" | ")} |\n| ${wideRow.join(" | ")} |`,
        },
      },
      {
        type: "table",
        spec: { columns: wideColumns, rows: [wideRow] },
      },
      ...(["left", "center", "right"] as const).map((align) => ({
        type: "table" as const,
        align,
        spec: { columns: ["Symbol", "Value"], rows: [["$A_t$", 42]] },
      })),
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
  const checkContentOverflow = async () => {
    const state = await evaluate<{
      vertical: string[];
      rootOverflow: string[];
      horizontal: string[];
      alignment: boolean[];
      wrappedTables: number;
    }>(`(async () => {
      await document.fonts.ready;
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const ids = ${JSON.stringify(excludedBlockIds.slice(3))};
      const roots = ids.map(id => document.querySelector('[data-block-id="' + id + '"] .block-content'));
      const state = { vertical: [], rootOverflow: roots.map(node => getComputedStyle(node).overflowY), horizontal: [], alignment: [], wrappedTables: 0 };
      state.wrappedTables = roots.flatMap(root => [...root.querySelectorAll('table')]).filter(table => !table.parentElement.classList.contains('block-content')).length;
      for (const [index, id] of ${JSON.stringify(excludedBlockIds.slice(-3))}.entries()) {
        const root = document.querySelector('[data-block-id="' + id + '"] .block-content');
        const rootBox = root.getBoundingClientRect();
        const first = root.querySelector('th').getBoundingClientRect();
        const last = root.querySelector('tr').lastElementChild.getBoundingClientRect();
        const left = first.left - rootBox.left;
        const right = rootBox.right - last.right;
        state.alignment.push(index === 0 ? Math.abs(left) < 1 : index === 1 ? Math.abs(left - right) < 1 : Math.abs(right) < 1);
      }
      for (const root of roots) {
        for (const node of [root, ...root.querySelectorAll('table, .katex-display, pre')]) {
          node.scrollTop = 10000;
          if (node.scrollTop > 0) state.vertical.push(root.closest('.block').dataset.blockId);
          node.scrollTop = 0;
          node.scrollLeft = 10000;
          if (node.scrollLeft > 0 && node !== root) {
            state.horizontal.push(node.tagName === 'PRE' ? 'code' : node.tagName === 'TABLE' ? 'table' : 'math');
          }
          node.scrollLeft = 0;
        }
      }
      return state;
    })()`);
    assert.deepEqual(
      state.vertical,
      [],
      "content must not have vertical scroll containers",
    );
    assert.ok(state.rootOverflow.every((value) => value === "visible"));
    assert.equal(
      state.wrappedTables,
      0,
      "tables must not need JS scroll wrappers",
    );
    assert.deepEqual(
      state.alignment,
      [true, true, true],
      "narrow tables retain left, center and right alignment",
    );
    for (const kind of ["code", "table", "math"]) {
      assert.ok(
        state.horizontal.includes(kind),
        `${kind} must retain local horizontal scrolling`,
      );
    }
  };
  for (const width of [1280, 768, 480]) {
    await send("Emulation.setDeviceMetricsOverride", {
      width,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await checkContentOverflow();
  }
  await send("Emulation.setDeviceMetricsOverride", {
    width: 1280,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  assert.equal(
    await evaluate(`(() => {
    const page = document.querySelector('.page').getBoundingClientRect();
    const selection = document.querySelector('.page-selection').getBoundingClientRect();
    return selection.left - page.left < 30 && selection.top - page.top < 30;
  })()`),
    true,
  );
  const checkAllFolds = async () => {
    await evaluate("document.getElementById('outline-toggle-all').click()");
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
    await evaluate("document.getElementById('outline-toggle-all').click()");
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
  assert.equal(
    await evaluate(
      "document.getElementById('outline-mode-semantic').getAttribute('aria-pressed')",
    ),
    "true",
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
  // Install guards before any application script, not after static bootstrap.
  const guardStatic = async (command: typeof send) => {
    await command("Runtime.enable");
    await command("Page.enable");
    await command("Network.enable");
    await command("Network.emulateNetworkConditions", {
      offline: true,
      latency: 0,
      downloadThroughput: 0,
      uploadThroughput: 0,
    });
    await command("Page.addScriptToEvaluateOnNewDocument", {
      source: `(() => {
        const attempts = window.staticAttempts = { fetch: 0, xhr: 0, ws: 0, onlineListeners: [] };
        window.fetch = new Proxy(window.fetch, { apply(target, self, args) { attempts.fetch++; return Reflect.apply(target, self, args); } });
        window.WebSocket = new Proxy(window.WebSocket, { construct(target, args) { attempts.ws++; return Reflect.construct(target, args); } });
        XMLHttpRequest.prototype.open = new Proxy(XMLHttpRequest.prototype.open, { apply(target, self, args) { attempts.xhr++; return Reflect.apply(target, self, args); } });
        EventTarget.prototype.addEventListener = new Proxy(EventTarget.prototype.addEventListener, {
          apply(target, self, args) {
            if (args[0] === 'beforeunload' || self instanceof Element && self.matches('.toolbar *, .page-select, .block-select, #reply-dialog *, #shutdown-dialog *'))
              attempts.onlineListeners.push([self.id || self.className || 'window', args[0]]);
            return Reflect.apply(target, self, args);
          }
        });
      })()`,
    });
  };
  const staticState = `(() => ({
    pageIds: Array.from(document.querySelectorAll('#pages .page'), node => node.dataset.pageId),
    blockIds: Array.from(document.querySelectorAll('#pages .block'), node => node.dataset.blockId),
    outlinePageIds: Array.from(document.querySelectorAll('#outline-list > .outline-page'), node => node.dataset.pageId),
    charts: Array.from(document.querySelectorAll('#pages .block')).filter(node => window.echarts.getInstanceByDom(node.querySelector('.block-content'))).map(node => node.dataset.blockId),
    promoted: !!document.querySelector('.outline-page > .outline-children > .outline-heading > .outline-page-row > button.outline-link[data-target-id="canvas-heading-${secondId}-0"]'),
    stableIds: Array.from(document.querySelectorAll('#pages .page')).every(node => node.id === 'page-' + node.dataset.pageId) && Array.from(document.querySelectorAll('#pages .block')).every(node => node.id === 'block-' + node.dataset.blockId),
    text: document.getElementById('pages').textContent,
    mode: document.documentElement.dataset.mode,
    hidden: Array.from(document.querySelectorAll('.toolbar, .page-selection, .block-select')).every(node => getComputedStyle(node).display === 'none' || !node.getClientRects().length),
    attempts: window.staticAttempts,
    imagesReady: Array.from(document.querySelectorAll('#pages img')).every(image => image.currentSrc.startsWith('data:image/') && image.complete && image.naturalWidth > 0),
    pictureSources: document.querySelectorAll('#pages picture source').length,
    injected: window.exportInjection === true
  }))()`;
  const inspectStatic = async (filename: string, blockIds: string[]) => {
    const { targetId: offlineTarget } = await cdp.send("Target.createTarget", {
      url: "about:blank",
    });
    const { sessionId: offlineSession } = await cdp.send(
      "Target.attachToTarget",
      { targetId: offlineTarget, flatten: true },
    );
    const command: typeof send = (method, params = {}) =>
      cdp.send(method, params, offlineSession);
    const inspect = async <T = unknown>(expression: string): Promise<T> => {
      const result = await command("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
      });
      assert.equal(
        result.exceptionDetails,
        undefined,
        JSON.stringify(result.exceptionDetails),
      );
      return result.result?.value as T;
    };
    try {
      await guardStatic(command);
      await command("Page.navigate", { url: pathToFileURL(filename).href });
      await until(
        () =>
          inspect(
            `document.documentElement?.dataset.mode === 'static' && document.querySelectorAll('#pages .block').length === ${blockIds.length} && document.querySelectorAll('#outline-list > .outline-page').length > 0 ${blockIds.includes(chartId) ? `&& !!document.querySelector('[data-block-id="${chartId}"] canvas')` : ""}`,
          ),
        "selected file shared renderer",
      );
      // Wait beyond the initial online reconnect delay, catching accidental retries.
      await delay(600);
      const state = await inspect<{
        pageIds: string[];
        blockIds: string[];
        outlinePageIds: string[];
        charts: string[];
        promoted: boolean;
        text: string;
        mode: string;
        hidden: boolean;
        stableIds: boolean;
        attempts: unknown;
        injected: boolean;
        imagesReady: boolean;
        pictureSources: number;
      }>(staticState);
      assert.equal(state.mode, "static");
      assert.equal(state.hidden, true);
      assert.equal(state.stableIds, true);
      assert.equal(state.injected, false);
      assert.equal(state.imagesReady, true);
      assert.equal(state.pictureSources, 0);
      assert.deepEqual(state.attempts, {
        fetch: 0,
        xhr: 0,
        ws: 0,
        onlineListeners: [],
      });
      assert.deepEqual(
        cdp.requests.filter(
          (request) =>
            request.sessionId === offlineSession &&
            /^(https?|wss?):/.test(request.url),
        ),
        [],
      );
      return state;
    } finally {
      await cdp.send("Target.closeTarget", { targetId: offlineTarget });
    }
  };
  const exportPayload = (html: string) => {
    assert.doesNotMatch(
      html,
      /<!--\s*include:/,
      "export uses the assembled common page",
    );
    const json =
      /<script\b(?=[^>]*\bid="document-data")(?=[^>]*\btype="application\/json")[^>]*>([\s\S]*?)<\/script>/i.exec(
        html,
      )?.[1];
    assert.ok(json, "export contains the data bootstrap");
    assert.doesNotMatch(json, /</, "payload escapes script-breaking text");
    return JSON.parse(json) as {
      doc: { pages: { id: string; blocks: { id: string }[] }[] };
      documentId: string;
      title: string;
      view: unknown;
    };
  };
  const checkExport = async (pageIds: string[], blockIds: string[]) => {
    const before = await liveState();
    const { html, filename } = await downloadHtml();
    assert.deepEqual(
      await liveState(),
      before,
      "HTML export preserves online DOM and selections",
    );
    const payload = exportPayload(html);
    assert.deepEqual(
      payload.doc.pages.map((page) => page.id),
      pageIds,
    );
    assert.deepEqual(
      payload.doc.pages.flatMap((page) => page.blocks.map((block) => block.id)),
      blockIds,
    );
    assert.equal(
      payload.documentId,
      await evaluate("document.getElementById('document-id').textContent"),
    );
    assert.equal(payload.title, await evaluate("document.title"));
    assert.ok(payload.view, "export preserves local outline view state");
    assert.doesNotMatch(
      html,
      /class="(?:page|block)"[^>]*data-(?:page|block)-id=/,
      "document is rendered only after bootstrap",
    );
    const parsed = await inspectStatic(filename, blockIds);
    assert.deepEqual(parsed.pageIds, pageIds);
    assert.deepEqual(parsed.blockIds, blockIds);
    assert.deepEqual(parsed.outlinePageIds, pageIds);
    assert.deepEqual(
      parsed.charts,
      blockIds.includes(chartId) ? [chartId] : [],
    );
    assert.doesNotMatch(parsed.text, /EXCLUDEDPAGESENTINEL/);
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
  const payload = exportPayload(exported);
  const expectedPages = [pageId, emptyPageId, excludedPageId];
  const expectedBlocks = [secondId, chartId, ...excludedBlockIds];
  assert.deepEqual(
    payload.doc.pages.map((page) => page.id),
    expectedPages,
  );
  assert.deepEqual(
    payload.doc.pages.flatMap((page) => page.blocks.map((block) => block.id)),
    expectedBlocks,
  );
  assert.match(exported, /EXCLUDEDPAGESENTINEL/);
  assert.ok(
    exported.includes("\\u003c/script>"),
    "hostile payload is script-safe",
  );
  assert.deepEqual(errors, []);
  assert.deepEqual(cdp.exceptions, []);
  assert.deepEqual(cdp.failures, []);
  // Close the live page/server, then deny network in the same real browser.
  await send("Page.navigate", { url: "about:blank" });
  await server.close();
  const offlineRequestStart = cdp.requests.length;
  await guardStatic(send);
  await send("Page.navigate", { url: pathToFileURL(filename).href });
  await until(
    () =>
      evaluate(
        `document.querySelectorAll('button.outline-link').length > 0 && !!document.querySelector('[data-block-id="${chartId}"] canvas')`,
      ),
    "offline exported document and chart",
  );
  await checkContentOverflow();
  assert.deepEqual(await labels(), [
    "Repeated heading",
    "Second",
    "Quoted heading",
  ]);
  const rendered = await evaluate<{
    pageIds: string[];
    blockIds: string[];
    hidden: boolean;
    injected: boolean;
  }>(staticState);
  assert.deepEqual(rendered.pageIds, expectedPages);
  assert.deepEqual(rendered.blockIds, expectedBlocks);
  assert.equal(rendered.hidden, true);
  assert.equal(rendered.injected, false);
  assert.equal(
    await evaluate(
      "document.querySelectorAll('.outline-heading .outline-heading').length",
    ),
    1,
  );
  await checkAllFolds();
  await evaluate("document.getElementById('outline-mode-structure').click()");
  assert.equal(
    await evaluate("document.querySelectorAll('.outline-block').length"),
    expectedBlocks.length,
  );
  await evaluate("document.getElementById('outline-mode-semantic').click()");
  assert.deepEqual(await labels(), [
    "Repeated heading",
    "Second",
    "Quoted heading",
  ]);
  assert.equal(
    await evaluate(
      `document.querySelector('[data-block-id="${excludedBlockIds[2]}"] pre code').textContent`,
    ),
    `const hostile = ${JSON.stringify(hostile)};`,
  );
  assert.equal(
    await evaluate(
      `!!document.querySelector('[data-block-id="${excludedBlockIds[2]}"] .hljs-keyword')`,
    ),
    true,
  );
  assert.equal(
    await evaluate(
      `!!document.querySelector('[data-block-id="${excludedBlockIds[3]}"] .katex') && !!document.querySelector('[data-block-id="${excludedBlockIds[4]}"] table') && !!document.querySelector('[data-block-id="${excludedBlockIds[4]}"] .katex')`,
    ),
    true,
  );
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
      `window.echarts.getInstanceByDom(document.querySelector('[data-block-id="${chartId}"] .block-content')).getOption().series[0].data`,
    ),
    [1, 2],
  );
  await evaluate(
    "window.offlineBranch.querySelector(':scope > .outline-page-row > .outline-page-toggle').click(); document.querySelector('.outline-heading button.outline-link').click()",
  );
  await until(
    () =>
      evaluate(
        `(() => { const rect = document.getElementById('canvas-heading-${secondId}-0').getBoundingClientRect(); return rect.top >= 0 && rect.top < innerHeight; })()`,
      ),
    "offline heading button navigation",
  );
  // A user-gesture evaluation exercises the real file:// clipboard API/fallback.
  const copyResult = await send("Runtime.evaluate", {
    expression: `document.querySelector('[data-block-id="${excludedBlockIds[2]}"] .block-copy').click()`,
    userGesture: true,
  });
  assert.equal(copyResult.exceptionDetails, undefined);
  await until(
    () =>
      evaluate(
        `document.querySelector('[data-block-id="${excludedBlockIds[2]}"] .block-copy').textContent === 'Copied'`,
      ),
    "offline code copy",
  );
  const offlinePdf = await send("Page.printToPDF", { printBackground: true });
  assert.ok(offlinePdf.data, "static shared print lifecycle generates PDF");
  await delay(600);
  assert.deepEqual(await evaluate("window.staticAttempts"), {
    fetch: 0,
    xhr: 0,
    ws: 0,
    onlineListeners: [],
  });
  assert.deepEqual(
    cdp.requests
      .slice(offlineRequestStart)
      .filter((request) => /^(https?|wss?):/.test(request.url)),
    [],
  );
  assert.deepEqual(cdp.exceptions, []);
  assert.deepEqual(cdp.failures, []);
});
