import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname } from "node:path";
import { test } from "node:test";
import { createReadTool } from "@earendil-works/pi-coding-agent";
import { buildFetchOutput } from "./format.ts";
import { formatDocument } from "./formatters/index.ts";
import { fetchDocument } from "./http.ts";

async function verifyFetchAndRead(url: string, expected?: string) {
  const response = await fetchDocument(
    { url: new URL(url) },
    { timeoutMs: 30_000 },
  );
  try {
    const output = buildFetchOutput(response);
    const saved = output.details.savedContent;
    const text = await readFile(saved.path, "utf8");
    if (expected !== undefined) assert.equal(text, expected);
    assert.equal(saved.bytes, Buffer.byteLength(text));
    assert.equal(saved.lines, text.split("\n").length);
    assert.equal(
      saved.maxLineBytes,
      Math.max(...text.split("\n").map((line) => Buffer.byteLength(line))),
    );
    const read = createReadTool(process.cwd());
    let offset = 1;
    let pages = 0;
    const chunks: string[] = [];
    while (true) {
      assert.ok(pages < 100, "pagination must make bounded progress");
      const result = await read.execute("read-integration", {
        path: saved.path,
        offset,
      });
      const body = result.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n");
      pages++;
      if (saved.maxLineBytes > 50 * 1_024) {
        assert.match(output.content[0].text, /Warning: a saved line/);
        if (body.startsWith("[Line ")) {
          assert.match(body, /exceeds .* limit/);
          break;
        }
      }
      const continuation = body.match(
        /\n\n\[Showing lines .*Use offset=(\d+) to continue\.\]$/,
      );
      chunks.push(continuation ? body.slice(0, continuation.index) : body);
      if (!continuation) {
        assert.equal(chunks.join("\n"), text);
        break;
      }
      const next = Number(continuation[1]);
      assert.ok(next > offset);
      offset = next;
    }
    return {
      url,
      bytes: saved.bytes,
      lines: saved.lines,
      maxLineBytes: saved.maxLineBytes,
      pages,
    };
  } finally {
    await rm(dirname(response.fullOutputPath), {
      recursive: true,
      force: true,
    });
  }
}

test("real HTTP fetch and built-in read cover small, paginated, and oversized-line files", async () => {
  const cases = [
    "中文🙂\nsmall file",
    Array.from({ length: 4_501 }, (_, i) => `line ${i}`).join("\n"),
    Array.from(
      { length: 1_201 },
      (_, i) => `${i}: ${"中文🙂".repeat(10)}`,
    ).join("\n"),
    "🙂".repeat(13_000),
  ];
  const server = createServer((req, res) => {
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end(cases[Number(req.url?.slice(1))]);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    for (const [index, expected] of cases.entries()) {
      const result = await verifyFetchAndRead(
        `http://127.0.0.1:${address.port}/${index}`,
        expected,
      );
      assert.equal(result.pages > 1, index === 1 || index === 2);
    }
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test("real HTTP formatting covers minified HTML, JSON, Markdown and failure fallback", async () => {
  const cases = [
    {
      contentType: "text/html",
      text: `<html><body>${"<p>中文 content with <b>structure</b>.</p>".repeat(3_001)}</body></html>`,
    },
    {
      contentType: "application/json",
      text: JSON.stringify(
        Array.from({ length: 3_001 }, (_, i) => ({ record: i })),
      ),
    },
    { contentType: "text/markdown", text: "# Heading\n\n-   item\n" },
    { contentType: "application/json", text: '{"broken":' },
  ];
  const server = createServer((req, res) => {
    const item = cases[Number(req.url?.slice(1))];
    res.setHeader("Content-Type", item.contentType);
    res.end(item.text);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    for (const [index, item] of cases.entries()) {
      const expected = await formatDocument(item);
      assert.equal(expected !== item.text, index !== 3);
      const result = await verifyFetchAndRead(
        `http://127.0.0.1:${address.port}/${index}`,
        expected,
      );
      assert.equal(result.pages > 1, index < 2);
    }
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test("live webpages fetch, layout metadata, and complete built-in read pagination", {
  skip: process.env.PI_KITS_LIVE_FETCH !== "1",
}, async (t) => {
  for (const url of [
    "https://example.com",
    "https://nodejs.org/api/fs.html",
    "https://nodejs.org/api/fs.json",
    "https://unpkg.com/prettier@3.9.9/README.md",
  ]) {
    const result = await verifyFetchAndRead(url);
    assert.ok(result.bytes > 0);
    if (url.includes("nodejs.org")) assert.ok(result.pages > 1);
    t.diagnostic(JSON.stringify(result));
  }
});
