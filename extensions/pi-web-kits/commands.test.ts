import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import {
  registerWebToolsCommand,
  type WebToolsCommandDependencies,
} from "./commands.ts";
import { resolveConfig, type WebToolsFileConfig } from "./config.ts";

interface CapturedCommand {
  getArgumentCompletions?: (
    prefix: string,
  ) => Array<{ value: string; label: string }> | null;
  handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
}

function capture(
  dependencies: WebToolsCommandDependencies = {},
): CapturedCommand {
  let command: CapturedCommand | undefined;
  const pi = {
    registerCommand(_name: string, options: CapturedCommand) {
      command = options;
    },
  } as unknown as ExtensionAPI;
  registerWebToolsCommand(pi, { env: {}, ...dependencies });
  assert.ok(command);
  return command;
}

function context(): {
  ctx: ExtensionCommandContext;
  notifications: string[];
} {
  const notifications: string[] = [];
  const ctx = {
    signal: undefined,
    modelRegistry: {
      getProviderAuthStatus: () => ({
        configured: true,
        source: "synthetic-source",
      }),
    },
    ui: {
      notify(text: string) {
        notifications.push(text);
      },
    },
  } as unknown as ExtensionCommandContext;
  return { ctx, notifications };
}

function currentConfig(): WebToolsFileConfig {
  return {
    search: {
      routing: {
        provider: "codex-alpha-search",
        fallback: true,
        fallbackProvider: "searxng",
      },
      timeoutMs: 5_000,
      maxResults: 2,
      codex: { model: "synthetic-codex-model" },
    },
    fetch: {
      timeoutMs: 5_000,
      github: { enabled: true },
    },
  };
}

test("registerWebToolsCommand: exposes status and provider test arguments", () => {
  const command = capture();
  assert.deepEqual(
    command.getArgumentCompletions?.("")?.map((completion) => completion.value),
    ["status", "test searxng", "test codex-alpha-search", "test github"],
  );
  assert.deepEqual(
    command
      .getArgumentCompletions?.("test se")
      ?.map((completion) => completion.value),
    ["test searxng"],
  );
  assert.deepEqual(command.getArgumentCompletions?.("configure"), null);
});

test("/web-tools status: reports separate search and fetch settings", async () => {
  const command = capture({
    readConfig: async () => currentConfig(),
    env: {
      SEARXNG_URL: "http://search.example/private/path",
      SEARXNG_API_KEY: "synthetic-api-key",
    },
  });
  const { ctx, notifications } = context();

  await command.handler("status", ctx);

  assert.equal(notifications.length, 1);
  const status = notifications[0] ?? "";
  assert.match(status, /search provider: Codex alpha\/search \(config\)/);
  assert.match(status, /search fallback: enabled \(config\)/);
  assert.match(status, /search fallback provider: SearXNG \(config\)/);
  assert.match(status, /fetch timeout: 5000 ms/);
  assert.match(status, /GitHub fetch: enabled/);
  assert.match(status, /GitHub uses read-only gh api/);
  assert.doesNotMatch(
    status,
    /GitHub mode:|clone threshold:|clone timeout:|shallow clone/,
  );
  assert.match(status, /Codex authentication: configured \(OAuth required\)/);
  assert.match(status, /SearXNG URL: configured \(env\)/);
  assert.match(status, /SearXNG Bearer key: set \(env\)/);
  assert.doesNotMatch(
    status,
    /private\/path|synthetic-api-key|synthetic-codex-model/,
  );
});

test("/web-tools configure: is intentionally unavailable", async () => {
  const command = capture();
  const { ctx, notifications } = context();

  await command.handler("configure", ctx);

  assert.deepEqual(notifications, [
    "/web-tools status\n/web-tools test <searxng|codex-alpha-search|github>",
  ]);
});

test("/web-tools test codex: accepts the alias and injects the runtime", async () => {
  let observedProvider = "";
  let observedFallback = true;
  let observedRegistry: unknown;
  const command = capture({
    readConfig: async () => currentConfig(),
    search: async (_request, config, runtime) => {
      observedProvider = config.provider;
      observedFallback = config.fallback;
      assert.deepEqual(config.sources.web.routing, ["codex-alpha-search"]);
      assert.equal(config.fallbackProvider, undefined);
      observedRegistry = runtime?.modelRegistry;
      return {
        query: "synthetic-query",
        results: [
          {
            title: "Synthetic result",
            url: "https://example.test/result",
            snippet: "Synthetic snippet",
          },
        ],
        provider: "codex-alpha-search",
      };
    },
  });
  const { ctx, notifications } = context();

  await command.handler("test codex", ctx);

  assert.equal(observedProvider, "codex-alpha-search");
  assert.equal(observedFallback, false);
  assert.equal(observedRegistry, ctx.modelRegistry);
  assert.deepEqual(notifications, [
    "Codex alpha/search test succeeded (1 result).",
  ]);
});

test("/web-tools uses startup snapshots without rereading config", async () => {
  let reads = 0;
  let observedMaxResults = 0;
  const rawConfig = currentConfig();
  const env = { SEARXNG_URL: "http://search.example" };
  const command = capture({
    config: {
      rawConfig,
      resolvedConfig: resolveConfig(rawConfig, env),
    },
    readConfig: async () => {
      reads += 1;
      throw new Error("startup snapshot should be used");
    },
    env,
    search: async (_request, config) => {
      observedMaxResults = config.maxResults;
      return {
        query: "synthetic-query",
        results: [],
        provider: config.provider,
      };
    },
  });
  const { ctx, notifications } = context();

  await command.handler("status", ctx);
  await command.handler("test searxng", ctx);

  assert.equal(reads, 0);
  assert.equal(observedMaxResults, 2);
  assert.equal(notifications.length, 2);
  assert.match(notifications[0] ?? "", /Codex alpha\/search \(config\)/);
  assert.match(notifications[1] ?? "", /SearXNG test succeeded \(0 results\)/);
});

test("/web-tools command errors remain classified and safe", async () => {
  const command = capture({
    readConfig: async () => {
      throw new Error("synthetic-raw-config-error");
    },
  });
  const { ctx, notifications } = context();

  await command.handler("status", ctx);

  assert.equal(notifications.length, 1);
  assert.match(notifications[0] ?? "", /\[network\]/);
  assert.doesNotMatch(notifications[0] ?? "", /synthetic-raw-config-error/);
});

test("/web-tools status: shows unified source and disabled tools; tests cannot bypass disable", async () => {
  const rawConfig: WebToolsFileConfig = {
    search: { enabled: false, routing: { fallback: true } },
    fetch: { enabled: false, github: { enabled: true } },
  };
  const command = capture({
    config: {
      rawConfig,
      resolvedConfig: resolveConfig(rawConfig, {}),
      configPath: "/synthetic/agent/pi-kits.json",
      source: "pi-kits",
    },
    search: async () => {
      assert.fail("disabled search must not run");
    },
  });
  const { ctx, notifications } = context();
  await command.handler("status", ctx);
  const status = notifications[0] ?? "";
  assert.match(status, /config file: \/synthetic\/agent\/pi-kits\.json/);
  assert.match(status, /config source: pi-kits/);
  assert.match(status, /web-kits: enabled/);
  assert.match(status, /web_search: disabled/);
  assert.match(status, /web_fetch: disabled/);
  assert.match(status, /search fallback: disabled/);
  assert.match(status, /GitHub fetch: disabled/);
  await command.handler("test searxng", ctx);
  assert.equal(notifications[1], "Web search is disabled by configuration.");
});

test("/web-tools status: reports defaults when the unified file is missing", async () => {
  const command = capture({
    config: {
      rawConfig: {},
      resolvedConfig: resolveConfig({}, {}),
      configPath: "/synthetic/agent/pi-kits.json",
      source: "defaults",
    },
  });
  const { ctx, notifications } = context();
  await command.handler("status", ctx);
  assert.match(notifications[0] ?? "", /config source: defaults/);
  assert.match(notifications[0] ?? "", /web_search: enabled/);
  assert.match(notifications[0] ?? "", /web_fetch: enabled/);
});

test("/web-tools test github: dispatches a safe repository query with runtime and signal", async () => {
  const { ctx, notifications } = context();
  const controller = new AbortController();
  Object.assign(ctx, { signal: controller.signal });
  let calls = 0;
  const command = capture({
    readConfig: async () => ({
      search: { sources: { web: { enabled: false } } },
    }),
    search: async () => assert.fail("GitHub must not use web adapters"),
    searchCapabilities: async (request, config, runtime, signal) => {
      calls += 1;
      assert.deepEqual(request, {
        source: "github",
        kind: "repositories",
        query: "repo:github/docs",
        maxResults: 1,
      });
      assert.equal(config.sources.web.enabled, false);
      assert.equal(runtime?.modelRegistry, ctx.modelRegistry);
      assert.equal(signal, controller.signal);
      return {
        query: request.query,
        results: [],
        provider: "github-gh",
        source: "github",
        kind: "repositories",
      };
    },
  });
  await command.handler("test github ignored input", ctx);
  assert.equal(calls, 1);
  assert.deepEqual(notifications, ["GitHub test succeeded (0 results)."]);
});

test("/web-tools: all disable layers block tests and hide disabled completions", async () => {
  for (const rawConfig of [
    { enabled: false },
    { search: { enabled: false } },
    {
      search: {
        enabled: false,
        sources: { web: { enabled: false }, github: { enabled: false } },
      },
    },
  ]) {
    const command = capture({
      config: { rawConfig, resolvedConfig: resolveConfig(rawConfig, {}) },
      search: async () => assert.fail("disabled web must not run"),
      searchCapabilities: async () =>
        assert.fail("disabled GitHub must not run"),
    });
    const { ctx, notifications } = context();
    assert.deepEqual(command.getArgumentCompletions?.(""), [
      { value: "status", label: "status" },
    ]);
    for (const target of ["searxng", "codex", "github"])
      await command.handler(`test ${target}`, ctx);
    assert.equal(notifications.length, 3);
    for (const text of notifications)
      assert.match(text, /disabled by configuration/);
  }
});

test("/web-tools: independent capability switches and cached completions", async () => {
  for (const enabled of ["web", "github"] as const) {
    const command = capture({
      readConfig: async () => ({
        search: {
          sources: {
            web: { enabled: enabled === "web" },
            github: { enabled: enabled === "github" },
          },
        },
      }),
    });
    const { ctx, notifications } = context();
    await command.handler("status", ctx);
    assert.match(
      notifications[0] ?? "",
      enabled === "web" ? /GitHub search: disabled/ : /Web search: disabled/,
    );
    const values = command
      .getArgumentCompletions?.("")
      ?.map(({ value }) => value);
    assert.deepEqual(
      values,
      enabled === "web"
        ? ["status", "test searxng", "test codex-alpha-search"]
        : ["status", "test github"],
    );
  }
});

test("/web-tools status: reports routing origins and no phantom fallback", async () => {
  const cases: Array<[WebToolsFileConfig, RegExp, RegExp, RegExp]> = [
    [
      {},
      /search routing: searxng \(default\)/,
      /search fallback provider: none/,
      /Codex model: configured \(default\)/,
    ],
    [
      {
        search: {
          routing: {
            provider: "codex",
            fallback: false,
            fallbackProvider: "searxng",
          },
          codex: { model: "private-model" },
        },
      },
      /search routing: codex-alpha-search \(search.routing \(legacy\)\)/,
      /search fallback provider: none/,
      /Codex model: configured \(config\)/,
    ],
    [
      {
        search: {
          sources: {
            web: {
              routing: ["searxng", "codex-alpha-search"],
              codex: { model: "private-model" },
            },
          },
        },
      },
      /search routing: searxng -> codex-alpha-search \(search.sources.web.routing\)/,
      /search fallback provider: Codex alpha\/search \(config\)/,
      /Codex model: configured \(config\)/,
    ],
    [
      { search: { sources: { web: {} } } },
      /search routing: searxng \(default\)/,
      /search fallback provider: none/,
      /Codex model: configured \(default\)/,
    ],
  ];
  for (const [rawConfig, routing, fallback, model] of cases) {
    const command = capture({
      config: { rawConfig, resolvedConfig: resolveConfig(rawConfig, {}) },
    });
    const { ctx, notifications } = context();
    await command.handler("status", ctx);
    const status = notifications[0] ?? "";
    assert.match(status, routing);
    assert.match(status, fallback);
    assert.match(status, model);
    assert.doesNotMatch(status, /private-model/);
  }
});

test("/web-tools test github: errors are classified and sanitized", async () => {
  const command = capture({
    readConfig: async () => ({}),
    searchCapabilities: async () => {
      throw new Error("private-gh-diagnostic");
    },
  });
  const { ctx, notifications } = context();
  await command.handler("test github", ctx);
  assert.match(notifications[0] ?? "", /\[network\]/);
  assert.doesNotMatch(notifications[0] ?? "", /private-gh-diagnostic/);
});
