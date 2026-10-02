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
      github: { enabled: true, mode: "auto" },
    },
  };
}

test("registerWebToolsCommand: exposes status and provider test arguments", () => {
  const command = capture();
  assert.deepEqual(
    command.getArgumentCompletions?.("")?.map((completion) => completion.value),
    ["status", "test searxng", "test codex-alpha-search"],
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
  assert.match(status, /GitHub mode: auto/);
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
    "/web-tools status\n/web-tools test <searxng|codex-alpha-search>",
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
