import assert from "node:assert/strict";
import { test } from "node:test";
import { WebSearchError } from "../../core/errors.ts";
import { normalizeSearxngBaseUrl } from "./config.ts";
import { createSearxngProvider } from "./provider.ts";

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

test("SearXNG endpoint validation excludes credentials, queries and fragments", () => {
  assert.equal(
    normalizeSearxngBaseUrl(" https://search.example/ "),
    "https://search.example",
  );
  for (const url of [
    "",
    "file:///tmp/search",
    "https://user:password@example.com",
    "https://search.example/?api_key=secret",
    "https://search.example/#token",
  ])
    assert.throws(() => normalizeSearxngBaseUrl(url), WebSearchError);
});

test("SearXNG accepts HTTP endpoints, including normal hosts, with Bearer keys", () => {
  for (const baseUrl of [
    "http://your-searxng-host",
    "http://localhost:8080",
    "http://127.0.0.1:8080",
    "http://[::1]:8080",
    "https://search.example",
  ])
    assert.doesNotThrow(() =>
      createSearxngProvider({ baseUrl, apiKey: "fixture-key" }),
    );
  assert.doesNotThrow(() => createSearxngProvider());
  assert.throws(
    () =>
      createSearxngProvider({
        baseUrl: "http://your-searxng-host",
        apiKey: "bad\r\nkey",
      }),
    WebSearchError,
  );
});

test("SearXNG sends OR filters and Bearer auth, then filters and deduplicates before limiting", async () => {
  let calledUrl: URL | undefined;
  let calledInit: RequestInit | undefined;
  const provider = createSearxngProvider({
    baseUrl: "https://search.example/",
    apiKey: "fixture-searx-key",
    fetch: async (input, init) => {
      calledUrl = new URL(input);
      calledInit = init;
      return response({
        results: [
          { title: "Outside", url: "https://notexample.com/" },
          { title: "First", url: "https://example.com/a#one", content: "one" },
          {
            title: "Duplicate",
            url: "https://example.com/a#two",
            content: "duplicate",
          },
          {
            title: "Second",
            url: "https://docs.example.org/b",
            description: "two",
          },
        ],
      });
    },
  });
  const result = await provider.search({
    query: "latest release",
    maxResults: 2,
    domains: ["example.com", "example.org"],
    recencyDays: 3,
  });
  assert.equal(calledUrl?.pathname, "/search");
  assert.equal(
    calledUrl?.searchParams.get("q"),
    "latest release (site:example.com OR site:example.org)",
  );
  assert.equal(calledUrl?.searchParams.get("format"), "json");
  assert.equal(calledUrl?.searchParams.get("time_range"), "week");
  assert.equal(calledInit?.redirect, "error");
  assert.equal(
    new Headers(calledInit?.headers).get("authorization"),
    "Bearer fixture-searx-key",
  );
  assert.deepEqual(result.results, [
    { title: "First", url: "https://example.com/a", snippet: "one" },
    { title: "Second", url: "https://docs.example.org/b", snippet: "two" },
  ]);
});

test("SearXNG classifies status, malformed responses and transport errors safely", async () => {
  for (const status of [400, 401, 403, 413, 429, 500, 302]) {
    const provider = createSearxngProvider({
      fetch: async () => response({ error: "fixture-secret-body" }, status),
    });
    await assert.rejects(
      provider.search({ query: "test", maxResults: 1 }),
      (error: unknown) => {
        assert.ok(error instanceof WebSearchError);
        assert.equal(error.status, status);
        assert.doesNotMatch(
          `${error.stack} ${JSON.stringify(error)}`,
          /fixture-secret-body/,
        );
        return true;
      },
    );
  }
  for (const body of ["not json", "{}", "[]", '{"results":{}}']) {
    const provider = createSearxngProvider({
      fetch: async () => new Response(body),
    });
    await assert.rejects(provider.search({ query: "test", maxResults: 1 }), {
      code: "invalid-response",
    });
  }
  const provider = createSearxngProvider({
    fetch: async () => {
      throw new Error("fixture-transport-secret");
    },
  });
  await assert.rejects(provider.search({ query: "test", maxResults: 1 }), {
    code: "network",
    message: "searxng could not be reached.",
  });
});
