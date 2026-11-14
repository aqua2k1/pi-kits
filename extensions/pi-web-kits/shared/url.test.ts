import assert from "node:assert/strict";
import { test } from "node:test";
import {
  decodeUrlComponent,
  isSensitivePathName,
  isSensitiveQueryName,
} from "./url.ts";

test("URL credential names include encoded and provider-specific query keys", () => {
  for (const name of [
    "access_token",
    "%2561ccess_token",
    "X-Amz-Signature",
    "hmac",
    "policy",
    "apiKey",
    "custom_token",
  ]) {
    assert.equal(isSensitiveQueryName(name), true, name);
  }
  for (const name of ["author", "article", "page"]) {
    assert.equal(isSensitiveQueryName(name), false, name);
  }
  assert.equal(isSensitivePathName("%2574oken"), true);
  assert.equal(isSensitivePathName("tokenized"), false);
  assert.equal(isSensitivePathName("author"), false);
});

test("URL decoding is bounded and tolerates malformed escapes", () => {
  let value = "token";
  for (let depth = 0; depth < 4; depth++) {
    value = value.replace(
      /./g,
      (char) => `%${char.charCodeAt(0).toString(16)}`,
    );
  }
  assert.equal(decodeUrlComponent(value), "token");
  const deeper = encodeURIComponent(value);
  assert.notEqual(decodeUrlComponent(deeper), "token");
  assert.equal(decodeUrlComponent("bad%escape"), "bad%escape");
});
