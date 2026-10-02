import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { test } from "node:test";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ExtensionToolContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { searchWeb } from "./composition.ts";
import { resolveFetchConfig, resolveSearchConfig } from "./config.ts";
import { WebSearchError } from "./core/errors.ts";
import type { FetchResponse } from "./fetch/types.ts";
import webToolsExtension, {
  registerWebFetchTool,
  registerWebSearchTool,
} from "./index.ts";

const key = "fixture-api-42/Plus+=value!";
const encode = (value: unknown) =>
  Buffer.from(JSON.stringify(value)).toString("base64url");
const token = `${encode({ alg: "none" })}.${encode({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture-account-123" } })}.signature`;
const baseContext = {
  modelRegistry: {
    getProviderAuth: async () => ({ auth: { apiKey: token }, source: "OAuth" }),
  },
} as unknown as ExtensionContext;

// Keep the existing minimal base fixture, but type-check Pi 1.0's tool context
// capabilities explicitly instead of casting the fixture to ExtensionToolContext.
const context: ExtensionToolContext = {
  ...baseContext,
  tools: [],
  executeTool: async () => {
    assert.fail("Unexpected nested tool execution in web-kit unit tests");
  },
};

function captureSearch(
  dependencies: Partial<Parameters<typeof registerWebSearchTool>[1]> = {},
): ToolDefinition {
  const tools: ToolDefinition[] = [];
  registerWebSearchTool(
    {
      registerTool: (tool: ToolDefinition) => tools.push(tool),
    } as unknown as ExtensionAPI,
    {
      ...dependencies,
      searchConfig: dependencies.searchConfig ?? resolveSearchConfig({}, {}),
    },
  );
  assert.equal(tools.length, 1);
  return tools[0];
}

function captureFetch(
  dependencies: Partial<Parameters<typeof registerWebFetchTool>[1]> = {},
): ToolDefinition {
  const tools: ToolDefinition[] = [];
  registerWebFetchTool(
    {
      registerTool: (tool: ToolDefinition) => tools.push(tool),
    } as unknown as ExtensionAPI,
    {
      ...dependencies,
      fetchConfig: dependencies.fetchConfig ?? resolveFetchConfig({}),
    },
  );
  assert.equal(tools.length, 1);
  return tools[0];
}

test("the extension entrypoint validates config before registering tools", async () => {
  const names: string[] = [];
  await webToolsExtension(
    {
      registerTool: (tool: ToolDefinition) => names.push(tool.name),
      registerCommand: (name: string) => names.push(name),
    } as unknown as ExtensionAPI,
    { readConfig: async () => ({}), env: {} },
  );
  assert.deepEqual(names, ["web_search", "web_fetch", "web-tools"]);
});

test("the command receives the startup config instead of rereading it", async () => {
  let reads = 0;
  type CommandHandler = (
    args: string,
    ctx: ExtensionCommandContext,
  ) => Promise<void>;
  let commandHandler: CommandHandler | undefined;
  await webToolsExtension(
    {
      registerTool: () => undefined,
      registerCommand: (
        _name: string,
        options: { handler: CommandHandler },
      ) => {
        commandHandler = options.handler;
      },
    } as unknown as ExtensionAPI,
    {
      readConfig: async () => {
        reads += 1;
        return { search: { maxResults: 2 } };
      },
      env: {},
    },
  );
  assert.ok(commandHandler);
  const notifications: string[] = [];
  await commandHandler("status", {
    modelRegistry: {},
    ui: { notify: (text: string) => notifications.push(text) },
  } as unknown as ExtensionCommandContext);
  assert.equal(reads, 1);
  assert.match(notifications[0] ?? "", /search default max results: 2/);
});

test("invalid config fails extension loading before tool registration", async () => {
  const names: string[] = [];
  await assert.rejects(
    webToolsExtension(
      {
        registerTool: (tool: ToolDefinition) => names.push(tool.name),
        registerCommand: (name: string) => names.push(name),
      } as unknown as ExtensionAPI,
      {
        readConfig: async () => ({ search: { maxResults: 0 } }),
        env: {},
      },
    ),
    (error: unknown) =>
      error instanceof WebSearchError && error.code === "invalid-config",
  );
  assert.deepEqual(names, []);
});

test("web_search registers the public parameter schema", () => {
  const tool = captureSearch();
  assert.equal(tool.name, "web_search");
  const schema = JSON.parse(JSON.stringify(tool.parameters));
  assert.deepEqual(schema.required, ["query"]);
  assert.deepEqual(schema.properties.provider.enum, [
    "searxng",
    "codex-alpha-search",
  ]);
  assert.equal(schema.properties.query.maxLength, 2_000);
  assert.equal(schema.properties.max_results.maximum, 10);
  assert.equal(schema.properties.domains.maxItems, 20);
  assert.equal(schema.properties.recency_days.maximum, 3_650);
});

test("web_fetch registers the URL and raw schema", () => {
  const tool = captureFetch();
  assert.equal(tool.name, "web_fetch");
  const schema = JSON.parse(JSON.stringify(tool.parameters));
  assert.deepEqual(schema.required, ["url"]);
  assert.equal(schema.properties.url.maxLength, 8_192);
  assert.equal(schema.properties.raw.type, "boolean");
});

test("registered search tool uses its resolved config", async () => {
  const tool = captureSearch({
    searchConfig: resolveSearchConfig({ maxResults: 7 }, {}),
    search: async (request, config) => {
      assert.equal(config.maxResults, 7);
      return {
        provider: "searxng",
        query: request.query,
        results: [],
      };
    },
  });
  await tool.execute(
    "search-call",
    { query: "test" },
    undefined,
    undefined,
    context,
  );
});

test("registered fetch tool uses its resolved config", async () => {
  const tool = captureFetch({
    fetchConfig: resolveFetchConfig({ timeoutMs: 1_000 }),
    fetch: async (_request, config) => {
      assert.equal(config.timeoutMs, 1_000);
      return {
        text: "fixture",
        finalUrl: "https://example.com/page",
        source: "native-http",
        fullOutputPath: "/tmp/pi-web-fetch-test/content.txt",
      };
    },
  });
  await tool.execute(
    "fetch-call",
    { url: "https://example.com/page" },
    undefined,
    undefined,
    context,
  );
});

for (const provider of ["searxng", "codex-alpha-search"] as const) {
  test(`${provider}: search composition does not leak credentials`, async () => {
    const credential = provider === "searxng" ? key : token;
    const reflection = `${credential} ${encodeURIComponent(credential)} ${Buffer.from(credential).toString("base64")} fixture-account-123`;
    const env =
      provider === "searxng"
        ? {
            SEARXNG_URL: "https://search.example",
            SEARXNG_API_KEY: key,
          }
        : {};
    const tool = captureSearch({
      searchConfig: resolveSearchConfig({}, env),
      search: (request, config, runtime, signal) =>
        searchWeb(
          request,
          config,
          {
            ...runtime,
            fetch: async (_url, init) => {
              assert.equal(init?.redirect, "error");
              assert.equal(
                new Headers(init?.headers).get("authorization"),
                `Bearer ${credential}`,
              );
              return Response.json({
                output: `Summary ${reflection} [signed](https://example.com/?access_token=unknown-secret#fragment-secret)`,
                results: [
                  { url: "https://user:password-secret@example.com/" },
                  {
                    title: reflection,
                    url: `https://example.com/${encodeURIComponent(credential)}?sig=signature-secret#fragment-secret`,
                    content: reflection,
                    snippet: reflection,
                  },
                ],
              });
            },
          },
          signal,
        ),
    });
    const updates: unknown[] = [];
    const output = await tool.execute(
      "test-call",
      { query: credential, provider, max_results: 1 },
      undefined,
      (update) => updates.push(update),
      context,
    );
    const serialized = JSON.stringify({ updates, output });
    for (const secret of [
      credential,
      encodeURIComponent(credential),
      Buffer.from(credential).toString("base64"),
      "unknown-secret",
      "password-secret",
      "signature-secret",
      "fragment-secret",
      ...(provider === "codex-alpha-search" ? ["fixture-account-123"] : []),
    ]) {
      assert.ok(!serialized.includes(secret), secret);
    }
    assert.ok(serialized.includes("redacted"));
    assert.equal((output.details as { resultCount: number }).resultCount, 1);
  });
}

test("web_fetch uses the fetch composition and reports a temp path", async () => {
  const response: FetchResponse = {
    text: "first line\nsecond line",
    title: "Synthetic page",
    contentType: "text/plain",
    contentLength: 22,
    finalUrl: "https://example.com/page",
    source: "native-http",
    fullOutputPath: "/tmp/pi-web-fetch-test/content.txt",
  };
  const tool = captureFetch({
    fetchConfig: resolveFetchConfig({}),
    fetch: async () => response,
  });
  const updates: unknown[] = [];
  const output = await tool.execute(
    "fetch-call",
    { url: "https://example.com/page?secret=hidden" },
    undefined,
    (update) => updates.push(update),
    context,
  );
  assert.equal(updates.length, 1);
  assert.equal(JSON.stringify(updates[0]).includes("secret=hidden"), false);
  assert.match(JSON.stringify(output), /fullOutputPath|content\.txt/);
  const content = output.content[0];
  assert.equal(content?.type, "text");
  if (content?.type === "text") assert.match(content.text, /Synthetic page/);
});

test("web_fetch uses the real native composition when a fetch runtime is injected", async () => {
  const tool = captureFetch({
    fetchConfig: resolveFetchConfig({ github: { enabled: false } }),
    fetchRuntime: {
      fetch: async () =>
        new Response("<title>Fixture</title><p>hello</p>", {
          headers: { "content-type": "text/html" },
        }),
    },
  });
  const output = await tool.execute(
    "fetch-call",
    { url: "https://example.com/page" },
    undefined,
    undefined,
    context,
  );
  const details = output.details as { fullOutputPath: string };
  assert.match(
    output.content[0]?.type === "text" ? output.content[0].text : "",
    /hello/,
  );
  assert.match(details.fullOutputPath, /pi-web-fetch-/);
  await rm(
    details.fullOutputPath.substring(
      0,
      details.fullOutputPath.lastIndexOf("/"),
    ),
    {
      recursive: true,
      force: true,
    },
  );
});

test("config read failures are classified during extension loading", async () => {
  const names: string[] = [];
  await assert.rejects(
    webToolsExtension(
      {
        registerTool: (tool: ToolDefinition) => names.push(tool.name),
        registerCommand: (name: string) => names.push(name),
      } as unknown as ExtensionAPI,
      {
        readConfig: async () => {
          throw new Error(key);
        },
        env: {},
      },
    ),
    (error: unknown) => {
      assert.ok(error instanceof WebSearchError);
      assert.ok(!String(error.stack).includes(key));
      return true;
    },
  );
  assert.deepEqual(names, []);
});
