import assert from "node:assert/strict";
import { test } from "node:test";
import { createRedactor, normalizeSearchResponse } from "./results.ts";

const request = { query: "test", maxResults: 10 };
const key = "fixture-api-42/Plus+=value!";
const token = "eyJhbGciOiJub25lIn0.eyJzdWIiOiIxMjMifQ.signature";

function result(url: string, title = "", snippet = "") {
  return { url, title, snippet };
}

test("redaction is request-local and covers literal, URI and base64 reflections", () => {
  const encoded = encodeURIComponent(key);
  const percent = [...Buffer.from(key)]
    .map((byte) => `%${byte.toString(16)}`)
    .join("");
  const variants = [
    key,
    encoded,
    encodeURIComponent(encoded),
    percent,
    Buffer.from(key).toString("base64"),
    Buffer.from(key).toString("base64url"),
  ];
  const redact = createRedactor([key]);
  for (const variant of variants)
    assert.equal(redact(`before ${variant} after`), "before [redacted] after");
  assert.equal(createRedactor()(key), key);
  assert.equal(createRedactor(["another-fixture"])(key), key);
  assert.doesNotMatch(
    createRedactor()(`Bearer ${token}; ${token}; api_key=unknown-value`),
    /eyJ|unknown-value/,
  );
});

test("all fields are sanitized before truncation, including query and summary links", () => {
  const url = `https://example.com/${encodeURIComponent(key)}?access_token=unknown-token#unknown-fragment`;
  const response = normalizeSearchResponse(
    { ...request, query: key },
    [result(url, `key ${key} ${token}`, `${key} [link](${url})`)],
    `See [source](${url}) and https://user:unknown-password@example.com/ and ${encodeURIComponent("https://user:encoded-password@example.com/")}`,
    [key],
  );
  const serialized = JSON.stringify(response);
  for (const value of [
    key,
    encodeURIComponent(key),
    token,
    "unknown-token",
    "unknown-fragment",
    "unknown-password",
    "encoded-password",
  ])
    assert.ok(!serialized.includes(value), value);
  assert.equal(response.results.length, 1);
  assert.match(serialized, /redacted/);
});

test("nested URI encoding is sanitized or rejected, including signed paths and HMAC links", () => {
  let encoded = "https://example.com/?sig=fixture-signature";
  for (let depth = 1; depth <= 8; depth++) {
    encoded = encodeURIComponent(encoded);
    const response = normalizeSearchResponse(request, [], encoded);
    assert.ok(!JSON.stringify(response).includes("fixture-signature"));
  }
  const response = normalizeSearchResponse(request, [
    result("https://example.com/signature/fixture-signature"),
    result("https://example.com/file?hmac=fixture-hmac"),
  ]);
  assert.doesNotMatch(
    JSON.stringify(response),
    /fixture-signature|fixture-hmac/,
  );
});

test("terminal controls are removed before credential redaction can reconstruct a secret", () => {
  const response = normalizeSearchResponse(
    request,
    [
      result(
        "https://example.com",
        "fixture-\u001b[31msecret\u001b[0m",
        "\u001b]52;c;data\u0007safe\u0000",
      ),
    ],
    undefined,
    ["fixture-secret"],
  );
  assert.equal(response.results[0].title, "[redacted]");
  assert.equal(response.results[0].snippet, "safe");
});

test("credential-bearing URLs are rejected, never used as a fallback title", () => {
  const response = normalizeSearchResponse(request, [
    result("https://user:fixture-password@example.com/"),
    result("https://user@example.com/"),
    result("javascript:alert(1)"),
    result("not a url"),
    result("https://example.com/safe"),
  ]);
  assert.deepEqual(response.results, [
    result("https://example.com/safe", "https://example.com/safe"),
  ]);
});

test("URL safety covers encoded keys, signed links, paths, fragments and nested URLs", () => {
  const response = normalizeSearchResponse(request, [
    result(
      "https://example.com/a?%2561ccess_token=fixture-a&X-Amz-Signature=fixture-b&sig=fixture-c&policy=fixture-d&ok=1#fixture-e",
    ),
    result("https://example.com/token/fixture-f"),
    result(
      `https://example.com/redirect?next=${encodeURIComponent("https://user:fixture-g@other.example")}`,
    ),
  ]);
  assert.doesNotMatch(JSON.stringify(response), /fixture-[a-g]/);
  assert.match(response.results[0].url, /ok=1/);
});

test("ordinary path and query names are not mistaken for credential fields", () => {
  const response = normalizeSearchResponse(request, [
    result("https://example.com/author/profile"),
    result("https://example.com/tokenized/profile"),
    result("https://example.com/?author=alice&article=1"),
  ]);
  assert.deepEqual(
    response.results.map((item) => item.url),
    [
      "https://example.com/author/profile",
      "https://example.com/tokenized/profile",
      "https://example.com/?author=alice&article=1",
    ],
  );
});

test("a credential reflected in a URL authority is omitted, not passed to URL parsers", () => {
  const response = normalizeSearchResponse(
    request,
    [
      result("https://fixture-secret.example/"),
      result("https://safe.example/"),
    ],
    undefined,
    ["fixture-secret"],
  );
  assert.equal(response.results.length, 1);
  assert.equal(response.results[0].url, "https://safe.example/");
});

test("domain filtering precedes the limit and URL deduplication is shared", () => {
  const response = normalizeSearchResponse(
    { ...request, domains: ["example.com"], maxResults: 2 },
    [
      result("https://example.com.evil.test/"),
      result("https://notexample.com/"),
      result("https://example.com/a?utm_source=one#one", "first"),
      result("https://example.com/a?utm_source=two#two", "duplicate"),
      result("https://docs.example.com/b", "second"),
    ],
  );
  assert.deepEqual(
    response.results.map((item) => item.title),
    ["first", "second"],
  );
  const wildcard = normalizeSearchResponse(
    { ...request, domains: ["*.example.com"] },
    [result("https://example.com"), result("https://docs.example.com")],
  );
  assert.equal(wildcard.results.length, 1);
});

test("fields use UTF-8 byte caps, oversized URLs are omitted, and truncation is explicit", () => {
  const text = "世界🙂\n".repeat(10_000);
  const response = normalizeSearchResponse(
    { ...request, query: text },
    [
      result(`https://example.com/${"a".repeat(60_000)}`),
      result("https://example.com/safe", text, text),
    ],
    text,
  );
  assert.equal(response.results.length, 1);
  assert.equal(response.truncated, true);
  assert.ok(Buffer.byteLength(response.query) <= 2_000);
  assert.ok(Buffer.byteLength(response.summary ?? "") <= 4_000);
  assert.ok(Buffer.byteLength(response.results[0].title) <= 500);
  assert.ok(Buffer.byteLength(response.results[0].snippet) <= 2_000);
  assert.doesNotMatch(JSON.stringify(response), /�/);
});
