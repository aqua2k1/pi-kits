import assert from "node:assert/strict";
import { test } from "node:test";
import {
  decodeDocument,
  extractTitle,
  htmlToText,
  isSupportedTextType,
} from "./content.ts";
import { WebFetchError } from "./errors.ts";

const bytes = (value: string) => new TextEncoder().encode(value);

test("htmlToText removes non-content blocks, decodes entities and keeps breaks", () => {
  const html = `<!doctype html><title>Docs &amp; More</title><style>.x{}</style><h1>Hello</h1><p>one &lt; two<br>three</p><script>alert(1)</script>`;
  assert.equal(extractTitle(html), "Docs & More");
  assert.equal(htmlToText(html), "Docs & More\nHello\none < two\nthree");
});

test("decodeDocument supports raw and extracted HTML", () => {
  const html = "<html><body><p>Hello</p><p>World</p></body></html>";
  const extracted = decodeDocument(
    bytes(html),
    "text/html; charset=utf-8",
    false,
  );
  assert.equal(extracted.text, "Hello\nWorld");
  assert.equal(extracted.title, undefined);
  const raw = decodeDocument(bytes(html), "text/html", true);
  assert.equal(raw.text, html);
});

test("decodeDocument accepts text and JSON but rejects binary content", () => {
  assert.equal(isSupportedTextType("text/plain"), true);
  assert.equal(isSupportedTextType("application/json"), true);
  assert.equal(isSupportedTextType("image/png"), false);
  assert.throws(
    () => decodeDocument(new Uint8Array([0, 1, 2]), "", false),
    (error: unknown) =>
      error instanceof WebFetchError && error.code === "unsupported",
  );
  assert.throws(
    () => decodeDocument(bytes("%PDF"), "application/pdf", false),
    (error: unknown) =>
      error instanceof WebFetchError && error.code === "unsupported",
  );
});

test("decodeDocument decodes numeric HTML entities", () => {
  const result = decodeDocument(
    bytes("<p>&#65; &#x1F600;</p>"),
    "text/html",
    false,
  );
  assert.equal(result.text, "A 😀");
});
