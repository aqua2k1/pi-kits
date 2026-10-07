import assert from "node:assert/strict";
import { test } from "node:test";
import {
  decodeDocument,
  extractTitle,
  isSupportedTextType,
} from "./content.ts";
import { WebFetchError } from "./errors.ts";

const bytes = (value: string) => new TextEncoder().encode(value);

test("title extraction still decodes entities without changing HTML body", async () => {
  const html =
    "<title>Docs &amp; More &#65; &#x1F600;</title><p>&lt;text&gt;</p>";
  const result = await decodeDocument(bytes(html), "text/html; charset=utf-8");
  assert.equal(extractTitle(html), "Docs & More A 😀");
  assert.equal(result.title, "Docs & More A 😀");
  assert.equal(
    result.text,
    "<title>Docs &amp; More &#65; &#x1F600;</title>\n<p>&lt;text&gt;</p>\n",
  );
});

test("decodeDocument formats HTML and preserves plain decoded text", async () => {
  const html = "<html><body><p>Hello</p><p>World</p></body></html>";
  const document = await decodeDocument(bytes(html), "text/html");
  assert.equal(
    document.text,
    "<html>\n  <body>\n    <p>Hello</p>\n    <p>World</p>\n  </body>\n</html>\n",
  );
  assert.equal(document.title, undefined);
  assert.equal(
    (await decodeDocument(bytes(" a\r\nb "), "text/plain")).text,
    " a\r\nb ",
  );
});

test("decodeDocument supports text, JSON and vendor JSON, but rejects binary", async () => {
  assert.equal(isSupportedTextType("text/plain"), true);
  assert.equal(isSupportedTextType("application/json"), true);
  assert.equal(isSupportedTextType("application/problem+json"), true);
  assert.equal(isSupportedTextType("image/png"), false);
  assert.equal(
    (await decodeDocument(bytes('{"x":1}'), "application/json")).text,
    '{ "x": 1 }\n',
  );
  await assert.rejects(
    decodeDocument(new Uint8Array([0, 1, 2]), ""),
    (error: unknown) =>
      error instanceof WebFetchError && error.code === "unsupported",
  );
  await assert.rejects(
    decodeDocument(bytes("%PDF"), "application/pdf"),
    (error: unknown) =>
      error instanceof WebFetchError && error.code === "unsupported",
  );
});

test("decodeDocument decodes charset before formatting and falls back on unknown encodings", async () => {
  const document = await decodeDocument(
    new Uint8Array([0x63, 0x61, 0x66, 0xe9]),
    "text/plain; charset=windows-1252",
  );
  assert.equal(document.text, "café");
  assert.equal(
    (await decodeDocument(bytes("中文"), "text/plain; charset=not-an-encoding"))
      .text,
    "中文",
  );
});

test("formatting failure saves the original decoded document", async () => {
  const text = '{"broken":';
  assert.equal(
    (await decodeDocument(bytes(text), "application/json")).text,
    text,
  );
});
