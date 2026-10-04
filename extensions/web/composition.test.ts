import assert from "node:assert/strict";
import { test } from "node:test";
import { searchWeb } from "./composition.ts";
import { resolveConfig } from "./config.ts";

const request = { query: "test", maxResults: 1 };

test("SearXNG composition neither requires a registry nor validates unused Codex settings", async () => {
  const config = resolveConfig(
    {
      search: { codex: { model: "x".repeat(1_000) } },
    },
    {
      SEARXNG_URL: "http://your-searxng-host",
      SEARXNG_API_KEY: "fixture-searx-key",
    },
  );
  const result = await searchWeb(request, config.search, {
    fetch: async () => Response.json({ results: [] }),
  });
  assert.equal(result.provider, "searxng");
});

test("Codex composition uses provider-level OAuth only", async () => {
  const token = `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify({ chatgpt_account_id: "fixture-account" })).toString("base64url")}.signature`;
  const config = resolveConfig(
    { search: { routing: { provider: "codex" } } },
    {},
  );
  const result = await searchWeb(request, config.search, {
    modelRegistry: {
      getProviderAuth: async () => ({
        source: "OAuth",
        auth: {
          apiKey: token,
          baseUrl: "https://untrusted.example",
          headers: { "foreign-header": "foreign-value" },
        },
      }),
    },
    fetch: async (url, init) => {
      assert.equal(
        String(url),
        "https://chatgpt.com/backend-api/codex/alpha/search",
      );
      assert.equal(new Headers(init?.headers).get("foreign-header"), null);
      return Response.json({ output: "" });
    },
  });
  assert.equal(result.provider, "codex-alpha-search");
});

test("fallback composition isolates provider credentials and preserves redacted queries", async () => {
  const token = `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify({ chatgpt_account_id: "fixture-account" })).toString("base64url")}.signature`;
  const seen: string[] = [];
  const config = resolveConfig(
    {
      search: {
        routing: {
          fallback: true,
          fallbackProvider: "codex-alpha-search",
        },
      },
    },
    {
      SEARXNG_URL: "https://search.example",
      SEARXNG_API_KEY: "fixture-searx-key",
    },
  );
  const result = await searchWeb({ ...request, query: token }, config.search, {
    modelRegistry: {
      getProviderAuth: async () => ({
        source: "OAuth",
        auth: { apiKey: token },
      }),
    },
    fetch: async (input, init) => {
      const headers = new Headers(init?.headers);
      seen.push(String(input).split("?")[0]);
      if (seen.length === 1) {
        assert.equal(headers.get("authorization"), "Bearer fixture-searx-key");
        assert.equal(headers.get("chatgpt-account-id"), null);
        return new Response(null, { status: 503 });
      }
      assert.equal(headers.get("authorization"), `Bearer ${token}`);
      assert.ok(!JSON.stringify([...headers]).includes("fixture-searx-key"));
      return Response.json({ output: "" });
    },
  });
  assert.equal(seen.length, 2);
  assert.equal(result.provider, "codex-alpha-search");
  assert.equal(result.query, "[redacted]");
});
