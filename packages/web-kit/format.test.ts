import assert from "node:assert/strict";
import { test } from "node:test";
import { buildSearchOutput } from "./format.ts";
import { MAX_OUTPUT_BYTES } from "./shared/limits.ts";
import { normalizeSearchResponse } from "./shared/results.ts";

test("tool text and details are derived from the same normalized response", () => {
  const output = buildSearchOutput({
    provider: "searxng",
    query: "latest news",
    summary: "A short summary.",
    results: [
      {
        title: "Example",
        url: "https://example.com/article",
        snippet: "A useful snippet.",
      },
    ],
  });
  assert.match(output.content[0].text, /\*\*Summary:\*\*/);
  assert.match(output.content[0].text, /\*\*Example\*\*/);
  assert.equal(output.details.resultCount, 1);
  assert.equal(output.details.hasSummary, true);
  assert.ok(output.content[0].text.includes(output.details.results[0].url));
});

test("aggregate budget counts text, details, UTF-8 and JSON escaping", () => {
  const response = normalizeSearchResponse(
    { query: "🙂".repeat(500), maxResults: 10 },
    Array.from({ length: 10 }, (_, index) => ({
      title: '"'.repeat(500),
      url: `https://example.com/${index}/${"a".repeat(1_900)}`,
      snippet: "🙂".repeat(1_000),
    })),
    "Summary ".repeat(1_000),
  );
  const output = buildSearchOutput({
    ...response,
    provider: "codex-alpha-search",
  });
  assert.ok(Buffer.byteLength(JSON.stringify(output)) <= MAX_OUTPUT_BYTES);
  assert.ok(output.content[0].text.split("\n").length <= 2_000);
  assert.equal(output.details.truncated, true);
  assert.match(output.content[0].text, /Output truncated/);
  assert.equal(output.details.resultCount, output.details.results.length);
  assert.ok(output.details.resultCount < response.results.length);
  assert.equal(response.results.length, 10);
});

test("untrusted text cannot create Markdown links or formatting in display fields", () => {
  const output = buildSearchOutput({
    provider: "searxng",
    query: "*query*",
    summary: "[forged](https://evil.example)",
    results: [
      {
        title: "[forged](https://evil.example)",
        url: "https://safe.example/",
        snippet: "**not bold**",
      },
    ],
  });
  assert.ok(output.content[0].text.includes(String.raw`\[forged\]`));
  assert.ok(output.content[0].text.includes(String.raw`\*\*not bold\*\*`));
  assert.equal(output.details.results[0].snippet, "**not bold**");
});

test("empty output stays concise", () => {
  const output = buildSearchOutput({
    provider: "searxng",
    query: "nothing",
    results: [],
  });
  assert.equal(output.content[0].text, 'No results found for "nothing".');
  assert.equal(output.details.hasSummary, false);
});
