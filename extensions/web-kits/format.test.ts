import assert from "node:assert/strict";
import { test } from "node:test";
import { Value } from "typebox/value";
import { WebSearchError } from "./core/errors.ts";
import { buildSearchOutput as buildOutput } from "./format.ts";
import { SearchDetailsSchema, SearchOutputSchema } from "./schema.ts";
import { MAX_OUTPUT_BYTES } from "./shared/limits.ts";
import { normalizeSearchResponse } from "./shared/results.ts";

function buildSearchOutput(...args: Parameters<typeof buildOutput>) {
  const output = buildOutput(...args);
  assert.ok(Value.Check(SearchOutputSchema, output.structuredContent));
  assert.ok(Value.Check(SearchDetailsSchema, output.details));
  const { summary, ...metadata } = output.structuredContent;
  assert.equal(Boolean(summary), output.details.hasSummary);
  assert.deepEqual(metadata, output.details);
  assert.ok(Buffer.byteLength(JSON.stringify(output)) <= MAX_OUTPUT_BYTES);
  return output;
}

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

test("aggregate budget counts text, details, machine data, UTF-8 and JSON escaping", () => {
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

test("provider truncation is preserved even for no-results output", () => {
  const output = buildSearchOutput({
    provider: "codex-alpha-search",
    query: "nothing",
    results: [],
    truncated: true,
  });
  assert.deepEqual(output.details, {
    query: "nothing",
    backend: "codex-alpha-search",
    resultCount: 0,
    results: [],
    hasSummary: false,
    truncated: true,
  });
  assert.equal(
    output.content[0].text,
    'No results found for "nothing".\n\n[Output truncated; omitted provider data was not saved.]',
  );
});

test("summary-only machine output includes the actual summary without changing legacy details", () => {
  const output = buildSearchOutput({
    provider: "codex-alpha-search",
    query: "test",
    summary: "Summary",
    results: [],
  });
  assert.equal(output.details.hasSummary, true);
  assert.equal(output.content[0].text, "**Summary:**\nSummary");
  assert.deepEqual(output.details, {
    query: "test",
    backend: "codex-alpha-search",
    resultCount: 0,
    results: [],
    hasSummary: true,
  });
  assert.equal(output.structuredContent.summary, "Summary");
});

test("ten bounded results cannot overflow the aggregate return budget", () => {
  const response = normalizeSearchResponse(
    { query: "test", maxResults: 10 },
    Array.from({ length: 10 }, (_, index) => ({
      title: "Example",
      url: `https://example.com/${index}`,
      snippet: "x".repeat(2_000),
    })),
  );
  const output = buildSearchOutput({ ...response, provider: "searxng" });
  assert.equal(response.results.length, 10);
  assert.ok(output.details.resultCount < 10);
  assert.equal(output.structuredContent.truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(output)) <= MAX_OUTPUT_BYTES);
});

test("an oversized summary-only response remains a classified failure", () => {
  assert.throws(
    () =>
      buildOutput({
        provider: "searxng",
        query: "test",
        results: [],
        summary: "x".repeat(MAX_OUTPUT_BYTES),
      }),
    (error: unknown) =>
      error instanceof WebSearchError && error.code === "invalid-response",
  );
});
