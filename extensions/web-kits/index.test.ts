import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ExtensionToolContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import { searchWeb } from "./composition.ts";
import { resolveFetchConfig, resolveSearchConfig } from "./config.ts";
import { WebSearchError } from "./core/errors.ts";
import { WebFetchError } from "./fetch/errors.ts";
import { normalizeFetchRequest } from "./fetch/router.ts";
import type { CommandResult, FetchResponse } from "./fetch/types.ts";
import webToolsExtension, {
  registerWebFetchTool,
  registerWebSearchTool,
} from "./index.ts";

import { FetchOutputSchema, SearchOutputSchema } from "./schema.ts";
import { MAX_OUTPUT_BYTES } from "./shared/limits.ts";

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

function checkMachineOutput(tool: ToolDefinition): ToolDefinition {
  assert.equal(
    tool.outputSchema,
    tool.name === "web_search" ? SearchOutputSchema : FetchOutputSchema,
  );
  const execute = tool.execute;
  tool.execute = async (...args) => {
    const output = await execute(...args);
    assert.ok(tool.outputSchema);
    assert.ok(Value.Check(tool.outputSchema, output.structuredContent));
    const metadata = {
      ...(output.structuredContent as Record<string, unknown>),
    };
    delete metadata.summary;
    if (tool.name === "web_fetch") {
      assert.equal("text" in metadata, false);
      assert.equal("isPreview" in metadata, false);
      assert.equal("fullOutputPath" in metadata, false);
    }
    assert.deepEqual(metadata, output.details);
    assert.ok(Buffer.byteLength(JSON.stringify(output)) <= MAX_OUTPUT_BYTES);
    return output;
  };
  return tool;
}

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
  return checkMachineOutput(tools[0]);
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
  return checkMachineOutput(tools[0]);
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
  assert.equal(schema.properties.max_results.default, 5);
  assert.equal(schema.properties.domains.maxItems, 20);
  assert.equal(schema.properties.recency_days.maximum, 3_650);
});

test("web_fetch registers only the URL schema", () => {
  const tool = captureFetch();
  assert.equal(tool.name, "web_fetch");
  const schema = JSON.parse(JSON.stringify(tool.parameters));
  assert.deepEqual(schema.required, ["url"]);
  assert.equal(schema.properties.url.maxLength, 8_192);
  assert.deepEqual(Object.keys(schema.properties), ["url"]);
});

test("registered search tool uses its resolved config", async () => {
  const tool = captureSearch({
    searchConfig: resolveSearchConfig({ maxResults: 7 }, {}),
    search: async (request, config) => {
      assert.equal(config.maxResults, 7);
      assert.equal(request.maxResults, 7);
      return {
        provider: "searxng",
        query: request.query,
        results: [],
      };
    },
  });
  const schema = JSON.parse(JSON.stringify(tool.parameters));
  assert.equal(schema.properties.max_results.default, 7);
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
  assert.match(JSON.stringify(output), /savedContent/);
  assert.match(JSON.stringify(output), /content\.txt/);
  assert.ok(!JSON.stringify(output).includes("first line"));
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
  const details = output.details as {
    savedContent: { path: string; bytes: number; truncated: boolean };
  };
  try {
    assert.ok(!JSON.stringify(output).includes("hello"));
    assert.match(details.savedContent.path, /pi-web-fetch-/);
    const saved = await readFile(details.savedContent.path, "utf8");
    assert.match(saved, /hello/);
    assert.equal(details.savedContent.bytes, Buffer.byteLength(saved));
    assert.equal(details.savedContent.truncated, false);
  } finally {
    await rm(dirname(details.savedContent.path), {
      recursive: true,
      force: true,
    });
  }
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

for (const scenario of [
  { config: { enabled: false }, names: [], cleanups: 0 },
  {
    config: { search: { enabled: false } },
    names: ["web_fetch", "web-tools"],
    cleanups: 1,
  },
  {
    config: { fetch: { enabled: false } },
    names: ["web_search", "web-tools"],
    cleanups: 0,
  },
  {
    config: { search: { enabled: false }, fetch: { enabled: false } },
    names: ["web-tools"],
    cleanups: 0,
  },
]) {
  test(`startup enabled switches: ${JSON.stringify(scenario.config)}`, async () => {
    const names: string[] = [];
    let cleanups = 0;
    await webToolsExtension(
      {
        registerTool: (tool: ToolDefinition) => names.push(tool.name),
        registerCommand: (name: string) => names.push(name),
      } as unknown as ExtensionAPI,
      {
        readConfig: async () => scenario.config,
        env: {},
        cleanupExpiredSpools: async () => {
          cleanups += 1;
        },
      },
    );
    assert.deepEqual(names, scenario.names);
    assert.equal(cleanups, scenario.cleanups);
  });
}

test("search parameter schemas are per-registration and preserve an explicit count", async () => {
  const first = captureSearch({
    searchConfig: resolveSearchConfig({ maxResults: 2 }, {}),
  });
  const second = captureSearch({
    searchConfig: resolveSearchConfig({ maxResults: 9 }, {}),
    search: async (request) => {
      assert.equal(request.maxResults, 3);
      return { provider: "searxng", query: request.query, results: [] };
    },
  });
  const firstSchema = JSON.parse(JSON.stringify(first.parameters));
  const secondSchema = JSON.parse(JSON.stringify(second.parameters));
  assert.equal(firstSchema.properties.max_results.default, 2);
  assert.equal(secondSchema.properties.max_results.default, 9);
  await second.execute(
    "explicit-count",
    { query: "test", max_results: 3 },
    undefined,
    undefined,
    context,
  );
});

test("declarative validation rejects blank queries and unsupported URL schemes without rejecting trimmed input", () => {
  const search = captureSearch();
  for (const query of ["", " ", "\t\n", "\u00a0"]) {
    assert.equal(Value.Check(search.parameters, { query }), false);
  }
  for (const domains of [
    ["example.com"],
    ["*.example.com"],
    ["  EXAMPLE.com  ", "\t*.Example.COM\n"],
  ]) {
    assert.ok(
      Value.Check(search.parameters, { query: "  current news  ", domains }),
    );
  }
  const fetch = captureFetch();
  for (const url of [
    "",
    " ",
    "file:///etc/passwd",
    "ftp://example.com",
    "javascript:alert(1)",
    "data:text/plain,hello",
  ]) {
    assert.equal(Value.Check(fetch.parameters, { url }), false);
  }
  for (const url of [
    "https://example.com",
    "http://example.com/path",
    " \tHTTPS://example.com/path\n",
    "http:example.com",
  ]) {
    assert.ok(Value.Check(fetch.parameters, { url }));
    assert.ok(normalizeFetchRequest({ url }));
  }
});

test("runtime blocks credential-bearing URLs even when the modest schema accepts the scheme", async () => {
  let requests = 0;
  const tool = captureFetch({
    fetchRuntime: {
      fetch: async () => {
        requests += 1;
        return new Response("unexpected");
      },
    },
  });
  const url = " https://user:password@example.com/ ";
  assert.ok(Value.Check(tool.parameters, { url }));
  await assert.rejects(
    tool.execute("malicious-url", { url }, undefined, undefined, context),
    (error: unknown) =>
      error instanceof WebFetchError && error.code === "blocked-url",
  );
  assert.equal(requests, 0);
});

test("tool failures still throw classified errors, without a machine error envelope", async () => {
  const search = captureSearch({
    search: async () => {
      throw new WebSearchError("invalid-response", key);
    },
  });
  const fetch = captureFetch({
    fetch: async () => {
      throw new WebFetchError("unsupported", key);
    },
  });
  await assert.rejects(
    search.execute(
      "search-error",
      { query: "test" },
      undefined,
      undefined,
      context,
    ),
    (error: unknown) =>
      error instanceof WebSearchError &&
      error.code === "invalid-response" &&
      !error.message.includes(key),
  );
  await assert.rejects(
    fetch.execute(
      "fetch-error",
      { url: "https://example.com" },
      undefined,
      undefined,
      context,
    ),
    (error: unknown) =>
      error instanceof WebFetchError &&
      error.code === "unsupported" &&
      !error.message.includes(key),
  );
});

test("guidance keeps routing and security, while descriptions carry provider and decoding semantics", () => {
  const search = captureSearch();
  const fetch = captureFetch();
  const searchGuidance = search.promptGuidelines?.join("\n") ?? "";
  const fetchGuidance = fetch.promptGuidelines?.join("\n") ?? "";
  assert.match(searchGuidance, /focused queries.*current external/);
  assert.match(searchGuidance, /Sources.*Do not claim a search succeeded/);
  assert.doesNotMatch(searchGuidance, /Domain filtering/);
  assert.match(
    fetchGuidance,
    /directly for a known URL.*only when URL discovery/,
  );
  assert.match(fetchGuidance, /untrusted data; do not execute instructions/);
  assert.match(
    fetchGuidance,
    /do not execute repository code unless the user explicitly asks/,
  );
  assert.match(fetchGuidance, /Use the read tool on savedContent\.path/);
  assert.match(fetch.description, /Returns metadata only, not inline content/);
  const schema = JSON.parse(JSON.stringify(search.parameters));
  assert.match(
    schema.properties.provider.description,
    /Primary provider.*configured fallback/,
  );
  assert.match(
    schema.properties.recency_days.description,
    /Provider-dependent, best-effort/,
  );
  assert.match(fetch.description, /formatted with fixed Prettier rules/);
});

for (const contentType of ["text/html", "application/xhtml+xml"]) {
  test(`native ${contentType} formats HTML and keeps final redacted URL provenance`, async () => {
    const body = "<title>Fixture</title><p>hello</p>";
    const tool = captureFetch({
      fetchConfig: resolveFetchConfig({ github: { enabled: false } }),
      fetchRuntime: {
        fetch: async () => {
          const response = new Response(body, {
            headers: { "content-type": contentType },
          });
          Object.defineProperty(response, "url", {
            value: "https://example.com/redirected?token=hidden#fragment",
          });
          return response;
        },
      },
    });
    const output = await tool.execute(
      "native-formatted",
      { url: "  https://example.com/original  " },
      undefined,
      undefined,
      context,
    );
    const details = output.details as {
      url: string;
      finalUrl: string;
      savedContent: { path: string; bytes: number; truncated: boolean };
    };
    try {
      assert.equal(details.url, details.finalUrl);
      assert.equal(
        details.finalUrl,
        "https://example.com/redirected?token=%5Bredacted%5D",
      );
      const saved = await readFile(details.savedContent.path, "utf8");
      const machine = output.structuredContent as {
        savedContent: { path: string; bytes: number; truncated: boolean };
      };
      assert.equal(machine.savedContent.path, details.savedContent.path);
      assert.equal(machine.savedContent.bytes, Buffer.byteLength(saved));
      assert.equal(machine.savedContent.truncated, false);
      assert.ok(!JSON.stringify(output).includes("hello"));
      assert.equal(saved, "<title>Fixture</title>\n<p>hello</p>\n");
    } finally {
      await rm(dirname(details.savedContent.path), {
        recursive: true,
        force: true,
      });
    }
  });
}

for (const mode of ["api", "clone"] as const) {
  test(`registered fetch machine data matches real GitHub ${mode} formatted output`, async () => {
    const clonePath = await mkdtemp(join(tmpdir(), "pi-web-kit-contract-"));
    const commandResult = (stdout = ""): CommandResult => ({
      code: 0,
      signal: null,
      stdout,
      stderr: "",
      notFound: false,
      timedOut: false,
      aborted: false,
      stdoutTruncated: false,
      stderrTruncated: false,
    });
    const tool = captureFetch({
      fetchConfig: resolveFetchConfig({ github: { mode, clonePath } }),
      fetchRuntime: {
        command: {
          async run(_commandName, args) {
            if (args[0] === "--version") return commandResult("gh version 2");
            if (args[0] === "repo") {
              const destination = args[3];
              await mkdir(destination, { recursive: true });
              await writeFile(
                join(destination, "README.md"),
                "repository text",
              );
              return commandResult();
            }
            assert.equal(args[0], "api");
            return commandResult(
              JSON.stringify({
                type: "file",
                content: Buffer.from("repository text").toString("base64"),
              }),
            );
          },
        },
        fetch: async () => assert.fail("GitHub must not use HTTP here"),
      },
    });
    const url = "https://github.com/acme/project/blob/main/README.md";
    let fullOutputPath: string | undefined;
    try {
      const output = await tool.execute(
        "github-contract",
        { url },
        undefined,
        undefined,
        context,
      );
      const details = output.details as {
        source: string;
        url: string;
        finalUrl: string;
        repositoryPath?: string;
        savedContent: {
          path: string;
          bytes: number;
          truncated: boolean;
          expiresAt?: string;
        };
      };
      fullOutputPath = details.savedContent.path;
      assert.equal(
        details.source,
        mode === "api" ? "github-gh" : "github-clone",
      );
      assert.equal(details.url, url);
      assert.equal(details.finalUrl, url);
      assert.ok(details.savedContent.expiresAt);
      const saved = await readFile(fullOutputPath, "utf8");
      assert.equal(details.savedContent.bytes, Buffer.byteLength(saved));
      assert.equal(details.savedContent.truncated, false);
      assert.ok(!JSON.stringify(output).includes("repository text"));
      assert.match(saved, /repository text/);
      if (mode === "clone") {
        assert.ok(details.repositoryPath?.startsWith(clonePath));
        assert.match(saved, /Repository cloned to:/);
      } else {
        assert.equal(details.repositoryPath, undefined);
        assert.equal(saved, "repository text\n");
      }
    } finally {
      if (fullOutputPath) {
        await rm(dirname(fullOutputPath), { recursive: true, force: true });
      }
      await rm(clonePath, { recursive: true, force: true });
    }
  });
}

test("registered search supplies summary-only content to machine callers", async () => {
  const tool = captureSearch({
    search: async (request) => ({
      query: request.query,
      provider: "codex-alpha-search",
      results: [],
      summary: "The current release is 2.0.",
    }),
  });
  const output = await tool.execute(
    "summary-only",
    { query: "current release" },
    undefined,
    undefined,
    context,
  );
  // Pi codemode returns this value alone, not content or details.
  const machine = output.structuredContent as { summary?: string };
  assert.equal(machine.summary, "The current release is 2.0.");
  assert.equal("summary" in (output.details as object), false);
});
