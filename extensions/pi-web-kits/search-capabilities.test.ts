import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  ExtensionAPI,
  ExtensionToolContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import { type SearchCapabilityRequest, search } from "./composition.ts";
import { resolveSearchConfig, type WebSearchFileConfig } from "./config.ts";
import { registerWebSearchTool } from "./index.ts";
import { SearchOutputSchema } from "./schema.ts";
import { GhRequestError } from "./shared/gh-request.ts";

const context = { modelRegistry: {} } as ExtensionToolContext;

function capture(config: WebSearchFileConfig = {}, execute?: typeof search) {
  let registered: ToolDefinition | undefined;
  registerWebSearchTool(
    {
      registerTool: (tool: ToolDefinition) => {
        registered = tool;
      },
    } as unknown as ExtensionAPI,
    { searchConfig: resolveSearchConfig(config, {}), search: execute },
  );
  assert.ok(registered);
  return registered;
}

test("search schema discriminates capabilities without accepting mixed arguments", () => {
  const tool = capture();
  for (const params of [
    { source: "web", query: "docs", domains: ["example.com"] },
    { source: "github", kind: "code", query: "AbortSignal repo:acme/repo" },
    { source: "github", kind: "pull-requests", query: "fix" },
  ])
    assert.ok(Value.Check(tool.parameters, params));
  for (const params of [
    { query: "missing source" },
    { source: "unknown", query: "test" },
    { source: "web", kind: "code", query: "test" },
    { source: "github", query: "missing kind" },
    { source: "github", kind: "unknown", query: "test" },
    { source: "github", kind: "code", query: "test", domains: [] },
    { source: "github", kind: "code", query: "test", recency_days: 1 },
    { source: "web", query: "test", provider: "codex" },
  ])
    assert.equal(
      Value.Check(tool.parameters, params),
      false,
      JSON.stringify(params),
    );
});

for (const disabled of ["web", "github"] as const) {
  test(`disabled ${disabled} capability is hidden and rejected before execution`, async () => {
    const tool = capture(
      { sources: { [disabled]: { enabled: false } } },
      async () => {
        assert.fail("Disabled capability must not execute");
      },
    );
    const schema = JSON.parse(JSON.stringify(tool.parameters));
    assert.deepEqual(schema.properties.source.enum, [
      disabled === "web" ? "github" : "web",
    ]);
    assert.equal("kind" in schema.properties, disabled !== "github");
    assert.equal("domains" in schema.properties, disabled !== "web");
    await assert.rejects(
      tool.execute(
        "disabled",
        {
          source: disabled,
          query: "test",
          ...(disabled === "github" ? { kind: "code" } : {}),
        },
        undefined,
        undefined,
        context,
      ),
      { code: "request" },
    );
  });
}

test("runtime tool validation rejects invalid branches even without harness validation", async () => {
  const tool = capture({}, async () =>
    assert.fail("Invalid request must not execute"),
  );
  for (const params of [
    { query: "test" },
    { source: "web", kind: "code", query: "test" },
    { source: "github", query: "test" },
  ]) {
    await assert.rejects(
      tool.execute("invalid", params, undefined, undefined, context),
      { code: "request" },
    );
  }
});

test("GitHub dispatch uses only gh and preserves output provenance", async () => {
  const config = resolveSearchConfig({}, {});
  const response = await search(
    {
      source: "github",
      kind: "repositories",
      query: "pi",
      maxResults: 1,
    },
    config,
    {
      modelRegistry: {
        getProviderAuth: async () => assert.fail("No Codex auth"),
      },
      fetch: async () => assert.fail("No web transport"),
      ghRequest: async (endpoint) => {
        assert.match(endpoint, /^search\/repositories\?/);
        assert.equal(
          new URLSearchParams(endpoint.split("?")[1]).get("q"),
          "pi",
        );
        return {
          total_count: 1,
          incomplete_results: false,
          items: [
            {
              full_name: "acme/pi",
              html_url: "https://github.com/acme/pi",
              description: "Pi project",
            },
          ],
        };
      },
    },
  );
  assert.equal(response.source, "github");
  assert.equal(response.kind, "repositories");
  assert.equal(response.provider, "github-gh");
  const tool = capture({}, async () => response);
  const output = await tool.execute(
    "github",
    {
      source: "github",
      kind: "repositories",
      query: "pi",
    },
    undefined,
    undefined,
    context,
  );
  assert.ok(Value.Check(SearchOutputSchema, output.structuredContent));
  assert.deepEqual(output.structuredContent, {
    source: "github",
    kind: "repositories",
    backend: "github-gh",
    query: "pi",
    resultCount: 1,
    results: response.results,
    hasSummary: false,
  });
});

test("web dispatch uses its explicit route and never touches gh", async () => {
  const attempts: string[] = [];
  const config = resolveSearchConfig(
    { sources: { web: { routing: ["codex-alpha-search", "searxng"] } } },
    {},
  );
  const response = await search(
    { source: "web", query: "docs", maxResults: 1 },
    config,
    {
      modelRegistry: {
        getProviderAuth: async () => {
          attempts.push("codex");
          return undefined;
        },
      },
      fetch: async () => {
        attempts.push("searxng");
        return Response.json({ results: [] });
      },
      ghRequest: async () => assert.fail("No GitHub transport"),
    },
  );
  assert.deepEqual(attempts, ["codex", "searxng"]);
  assert.equal(response.source, "web");
  assert.equal(response.provider, "searxng");
});

test("GitHub failures never fall back to web and expose no upstream diagnostics", async () => {
  const config = resolveSearchConfig(
    { sources: { web: { routing: ["searxng", "codex-alpha-search"] } } },
    {},
  );
  await assert.rejects(
    search(
      { source: "github", kind: "code", query: "test", maxResults: 1 },
      config,
      {
        fetch: async () => assert.fail("No cross-capability fallback"),
        ghRequest: async () => {
          throw new GhRequestError("rate-limit", 429);
        },
      },
    ),
    { code: "rate-limit" },
  );
});

test("dispatch rejects disabled capabilities, unknown sources, and cancellation before transport", async () => {
  const runtime = {
    fetch: async () => assert.fail("No HTTP"),
    ghRequest: async () => assert.fail("No gh"),
  };
  for (const source of ["web", "github"] as const) {
    const config = resolveSearchConfig(
      { sources: { [source]: { enabled: false } } },
      {},
    );
    const request: SearchCapabilityRequest =
      source === "web"
        ? { source, query: "test", maxResults: 1 }
        : { source, kind: "code", query: "test", maxResults: 1 };
    await assert.rejects(search(request, config, runtime), {
      code: "unsupported",
    });
  }
  const config = resolveSearchConfig({}, {});
  await assert.rejects(
    search(
      {
        source: "unknown",
        query: "test",
        maxResults: 1,
      } as unknown as SearchCapabilityRequest,
      config,
      runtime,
    ),
    { code: "request" },
  );
  for (const source of ["web", "github"] as const) {
    const request: SearchCapabilityRequest =
      source === "web"
        ? { source, query: "test", maxResults: 1 }
        : { source, kind: "code", query: "test", maxResults: 1 };
    await assert.rejects(
      search(request, config, runtime, AbortSignal.abort()),
      { code: "cancelled" },
    );
  }
});
