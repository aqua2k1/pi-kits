import assert from "node:assert/strict";
import { test } from "node:test";
import { formatDocument } from "./formatters/index.ts";

test("HTML is formatted, not extracted, with sensitive contents retained", async () => {
  const text =
    "<!doctype html><html><head><title>Test</title><style>.a{color:red}</style></head><body><p>Hello <b>world</b>!</p><pre>  a\n    b</pre><script>const x={a:1};</script></body></html>";
  const formatted = await formatDocument({ text, contentType: "text/html" });
  assert.ok(formatted.includes("\n"));
  assert.match(formatted, /<p>Hello <b>world<\/b>!<\/p>/);
  // HTML ignores the first newline immediately following an opening pre tag.
  assert.match(formatted, /<pre>\n? {2}a\n {4}b<\/pre>/);
  assert.match(formatted, /\.a\{color:red\}/);
  assert.match(formatted, /const x=\{a:1\};/);
  assert.equal(
    await formatDocument({ text: formatted, contentType: "text/html" }),
    formatted,
  );
});

test("JSON formatting preserves numeric literals, keys and string values", async () => {
  const text =
    '{"large":900719925474099312345,"decimal":1.234567890123456789,"scientific":1e400,"negzero":-0,"text":"中文\\n🙂","nested":{"x":[1,2]}}';
  const formatted = await formatDocument({
    text,
    contentType: "application/json",
  });
  for (const literal of [
    "900719925474099312345",
    "1.234567890123456789",
    "1e400",
    "-0",
  ]) {
    assert.ok(formatted.includes(literal));
  }
  assert.equal(JSON.parse(formatted).text, "中文\n🙂");
  assert.match(formatted, /\n {2}"large":/);
  assert.ok(formatted.indexOf('"large"') < formatted.indexOf('"decimal"'));
  assert.equal(
    await formatDocument({ text: formatted, contentType: "application/json" }),
    formatted,
  );
});

test("Markdown is formatted without reformatting embedded code", async () => {
  const text = '# Heading\r\n\r\n-   item\r\n\r\n```json\r\n{"x":1}\r\n```\r\n';
  const formatted = await formatDocument({
    text,
    contentType: "text/markdown",
  });
  assert.equal(formatted, '# Heading\n\n- item\n\n```json\n{"x":1}\n```\n');
  assert.equal(
    await formatDocument({ text: formatted, contentType: "text/markdown" }),
    formatted,
  );
});

test("MIME routing takes precedence, with filename fallback only for generic text", async () => {
  const json = '{"x":1}';
  const expected = '{ "x": 1 }\n';
  for (const contentType of [
    "application/json",
    "Application/JSON; charset=utf-8",
    "application/ld+json",
    "application/manifest+json",
  ]) {
    assert.equal(
      await formatDocument({ text: json, contentType, filePath: "wrong.html" }),
      expected,
    );
  }
  assert.equal(
    await formatDocument({
      text: json,
      contentType: "text/plain",
      filePath: "DATA.JSON",
    }),
    expected,
  );
  assert.equal(
    await formatDocument({ text: json, filePath: "data.json" }),
    expected,
  );
  assert.equal(
    await formatDocument({
      text: "<p>Hello</p>",
      contentType: "application/xhtml+xml",
    }),
    "<p>Hello</p>\n",
  );
  assert.equal(
    await formatDocument({ text: "<p>Hello</p>" }),
    "<p>Hello</p>\n",
  );
  assert.equal(
    await formatDocument({
      text: json,
      contentType: "application/xml",
      filePath: "wrong.json",
    }),
    json,
  );
});

test("plain text, XML, unknown formats and formatting failures preserve input exactly", async () => {
  for (const input of [
    { text: "  中文\r\n\t🙂  ", contentType: "text/plain" },
    { text: "<root>  a <b/> b </root>", contentType: "application/xml" },
    { text: "<root/>", contentType: "text/xml" },
    { text: "some data", contentType: "text/csv" },
    { text: '{"broken":', contentType: "application/json" },
    { text: "<div></span>", contentType: "text/html" },
    { text: "", contentType: "text/plain" },
  ]) {
    assert.equal(await formatDocument(input), input.text);
  }
});

test("formatting cancellation terminates the worker and preserves input", async () => {
  const controller = new AbortController();
  const text = '[{"x":1}]';
  const pending = formatDocument({
    text,
    contentType: "application/json",
    signal: controller.signal,
  });
  controller.abort();
  assert.equal(await pending, text);
  assert.equal(
    await formatDocument({
      text,
      contentType: "application/json",
      signal: controller.signal,
    }),
    text,
  );
});

test("large formatting work stays off the agent thread and falls back within its budget", {
  timeout: 15_000,
}, async () => {
  const text = `[${'{"x":1},'.repeat(250_000)}{"x":1}]`;
  let heartbeat = false;
  const timer = setTimeout(() => {
    heartbeat = true;
  }, 10);
  try {
    assert.equal(
      await formatDocument({ text, contentType: "application/json" }),
      text,
    );
    assert.equal(
      heartbeat,
      true,
      "main-thread timers must not be blocked by parsing",
    );
  } finally {
    clearTimeout(timer);
  }
});

test("fixed print width is not a hard byte cap and does not corrupt giant strings", async () => {
  const value = "🙂".repeat(13_000);
  const formatted = await formatDocument({
    text: JSON.stringify({ value }),
    contentType: "application/json",
  });
  assert.equal(JSON.parse(formatted).value, value);
  assert.ok(
    formatted.split("\n").some((line) => Buffer.byteLength(line) > 50 * 1_024),
  );
});
