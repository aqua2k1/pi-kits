import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { search as searchCapabilities, searchWeb } from "./composition.ts";
import {
  getConfigPath,
  normalizeProviderName,
  type ResolvedWebSearchConfig,
  type ResolvedWebToolsConfig,
  type readConfig,
  readConfigSnapshot,
  resolveConfig,
  type WebSearchFileConfig,
  type WebToolsConfigFileSnapshot,
} from "./config.ts";
import { errorMessageForCode, toWebSearchError } from "./search/errors.ts";
import {
  WEB_SEARCH_PROVIDER_NAMES,
  type WebSearchProviderName,
} from "./search/types.ts";

const PROVIDER_LABELS: Record<WebSearchProviderName, string> = {
  searxng: "SearXNG",
  "codex-alpha-search": "Codex alpha/search",
};
const COMMAND_ARGUMENTS = [
  "status",
  ...WEB_SEARCH_PROVIDER_NAMES.map((name) => `test ${name}`),
  "test github",
];
const DEFAULT_SEARCH_QUERY = "pi web search connectivity";
const GITHUB_TEST_QUERY = "repo:github/docs";
const USAGE_TEXT =
  "/pi-web-kits status\n/pi-web-kits test <searxng|codex-alpha-search|github>";
type ConfigSource = "env" | "config" | "default" | "none";

export interface WebToolsConfigSnapshot
  extends Partial<Omit<WebToolsConfigFileSnapshot, "rawConfig">> {
  readonly rawConfig: WebToolsConfigFileSnapshot["rawConfig"];
  readonly resolvedConfig: ResolvedWebToolsConfig;
}

export interface WebToolsCommandDependencies {
  /** The single configuration snapshot loaded during extension startup. */
  config?: WebToolsConfigSnapshot;
  /** Legacy fallback for callers that do not provide a startup snapshot. */
  readConfig?: typeof readConfig;
  search?: typeof searchWeb;
  searchCapabilities?: typeof searchCapabilities;
  env?: NodeJS.ProcessEnv;
}

function commandErrorText(error: unknown): string {
  const classified = toWebSearchError(error);
  return `${errorMessageForCode(classified.code)} [${classified.code}]`;
}

function formatResultCount(count: number): string {
  return `${count} result${count === 1 ? "" : "s"}`;
}

function source(
  envValue: string | undefined,
  configValue: string | undefined,
  hasDefault: boolean,
): ConfigSource {
  if (envValue?.trim()) return "env";
  if (configValue?.trim()) return "config";
  return hasDefault ? "default" : "none";
}

function describeRoutingStatus(
  rawSearch: WebSearchFileConfig,
  routing: readonly WebSearchProviderName[],
) {
  const web = rawSearch.sources?.web;
  const fallbackProvider = routing[1];
  if (web) {
    return {
      routingSource:
        web.routing === undefined ? "default" : "search.sources.web.routing",
      providerSource: source(undefined, web.routing?.[0], true),
      fallbackSource: source(undefined, web.routing?.[0], true),
      fallbackProvider,
      fallbackProviderSource: source(undefined, web.routing?.[1], true),
      codexModel: web.codex?.model,
    };
  }
  return {
    routingSource:
      rawSearch.routing === undefined ? "default" : "search.routing (legacy)",
    providerSource: source(undefined, rawSearch.routing?.provider, true),
    fallbackSource:
      rawSearch.routing?.fallback === undefined ? "default" : "config",
    fallbackProvider,
    fallbackProviderSource:
      rawSearch.routing?.fallbackProvider === undefined ? "default" : "config",
    codexModel: rawSearch.codex?.model,
  };
}

function readCodexAuthStatus(ctx: ExtensionCommandContext): string {
  try {
    return ctx.modelRegistry.getProviderAuthStatus("openai-codex").configured
      ? "configured (OAuth required)"
      : "not configured";
  } catch {
    // Keep status useful when the host registry is unavailable.
    return "unavailable";
  }
}

function statusText(
  snapshot: WebToolsConfigSnapshot,
  ctx: ExtensionCommandContext,
  env: NodeJS.ProcessEnv,
): string {
  const { rawConfig: raw, resolvedConfig: config } = snapshot;
  const searchEnabled = config.enabled && config.search.enabled;
  const fetchEnabled = config.enabled && config.fetch.enabled;
  const webEnabled = searchEnabled && config.search.sources.web.enabled;
  const githubEnabled = searchEnabled && config.search.sources.github.enabled;
  const routing = config.search.sources.web.routing;
  const routingStatus = describeRoutingStatus(raw.search ?? {}, routing);
  const keySource = source(env.SEARXNG_API_KEY, undefined, false);
  const auth = readCodexAuthStatus(ctx);
  return [
    "Web tools configuration:",
    `  config file: ${snapshot.configPath ?? getConfigPath()}`,
    `  config source: ${snapshot.source ?? "injected"}`,
    `  web-kits: ${config.enabled ? "enabled" : "disabled"}`,
    `  web_search: ${searchEnabled ? "enabled" : "disabled"}`,
    `  web_fetch: ${fetchEnabled ? "enabled" : "disabled"}`,
    `  Web search: ${webEnabled ? "enabled" : "disabled"}`,
    `  GitHub search: ${githubEnabled ? "enabled" : "disabled"} (gh api)`,
    `  search routing: ${routing.join(" -> ")} (${routingStatus.routingSource})`,
    `  search provider: ${PROVIDER_LABELS[config.search.provider]} (${routingStatus.providerSource})`,
    `  search fallback: ${webEnabled && routing.length > 1 ? "enabled" : "disabled"} (${routingStatus.fallbackSource})`,
    `  search fallback provider: ${routingStatus.fallbackProvider ? PROVIDER_LABELS[routingStatus.fallbackProvider] : "none"} (${routingStatus.fallbackProviderSource})`,
    `  search timeout: ${config.search.timeoutMs} ms`,
    `  search default max results: ${config.search.maxResults}`,
    `  SearXNG URL: configured (${source(env.SEARXNG_URL, undefined, true)})`,
    `  SearXNG Bearer key: ${keySource === "none" ? "not set" : `set (${keySource})`}`,
    `  Codex model: configured (${source(undefined, routingStatus.codexModel, true)})`,
    `  Codex authentication: ${auth}`,
    `  fetch timeout: ${config.fetch.timeoutMs} ms`,
    `  GitHub fetch: ${fetchEnabled && config.fetch.github.enabled ? "enabled" : "disabled"}`,
    "",
    "Settings are under pi-web-kits.search and pi-web-kits.fetch in pi-kits.json.",
    "SearXNG URL and credentials are read from environment variables.",
    "GitHub uses read-only gh api for search, files, directories, root README and brief repository info; no automatic clones.",
  ].join("\n");
}

async function testProvider(
  ctx: ExtensionCommandContext,
  provider: WebSearchProviderName,
  config: ResolvedWebToolsConfig,
  search: typeof searchWeb,
): Promise<void> {
  const searchConfig: ResolvedWebSearchConfig = {
    ...config.search,
    provider,
    fallback: false,
    fallbackProvider: undefined,
    sources: {
      ...config.search.sources,
      web: { ...config.search.sources.web, routing: [provider] },
    },
  };
  const response = await search(
    { query: DEFAULT_SEARCH_QUERY, maxResults: 1 },
    searchConfig,
    { modelRegistry: ctx.modelRegistry },
    ctx.signal,
  );
  ctx.ui.notify(
    `${PROVIDER_LABELS[response.provider]} test succeeded (${formatResultCount(response.results.length)}).`,
    "info",
  );
}

async function testGitHub(
  ctx: ExtensionCommandContext,
  config: ResolvedWebToolsConfig,
  searchGitHub: typeof searchCapabilities,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const response = await searchGitHub(
    {
      source: "github",
      kind: "repositories",
      query: GITHUB_TEST_QUERY,
      maxResults: 1,
    },
    config.search,
    { modelRegistry: ctx.modelRegistry, env },
    ctx.signal,
  );
  ctx.ui.notify(
    `GitHub test succeeded (${formatResultCount(response.results.length)}).`,
    "info",
  );
}

async function handleTestCommand(
  target: string | undefined,
  loadCurrentSnapshot: () => Promise<WebToolsConfigSnapshot>,
  ctx: ExtensionCommandContext,
  search: typeof searchWeb,
  searchGitHub: typeof searchCapabilities,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const provider = normalizeProviderName(target);
  const isGitHub = target === "github";
  if (!provider && !isGitHub) {
    ctx.ui.notify(
      "Choose a test target: searxng, codex-alpha-search or github.",
      "error",
    );
    return;
  }
  const { resolvedConfig } = await loadCurrentSnapshot();
  if (!resolvedConfig.enabled || !resolvedConfig.search.enabled) {
    ctx.ui.notify("Web search is disabled by configuration.", "info");
    return;
  }
  const capability = isGitHub ? "github" : "web";
  if (!resolvedConfig.search.sources[capability].enabled) {
    ctx.ui.notify(
      `${isGitHub ? "GitHub" : "Web"} search is disabled by configuration.`,
      "info",
    );
    return;
  }
  if (isGitHub) {
    await testGitHub(ctx, resolvedConfig, searchGitHub, env);
  } else if (provider) {
    await testProvider(ctx, provider, resolvedConfig, search);
  }
}

async function loadSnapshot(
  provided: WebToolsCommandDependencies,
  env: NodeJS.ProcessEnv,
): Promise<WebToolsConfigSnapshot> {
  if (provided.config) return provided.config;
  const snapshot = provided.readConfig
    ? {
        rawConfig: await provided.readConfig(getConfigPath()),
        source: "injected" as const,
      }
    : await readConfigSnapshot();
  return {
    ...snapshot,
    resolvedConfig: resolveConfig(snapshot.rawConfig, env),
  };
}

export function registerWebToolsCommand(
  pi: ExtensionAPI,
  provided: WebToolsCommandDependencies = {},
): void {
  const env = { ...(provided.env ?? process.env) };
  const search = provided.search ?? searchWeb;
  const searchGitHub = provided.searchCapabilities ?? searchCapabilities;
  let resolved = provided.config?.resolvedConfig;
  let snapshotPromise: Promise<WebToolsConfigSnapshot> | undefined;
  const snapshot = (): Promise<WebToolsConfigSnapshot> => {
    snapshotPromise ??= loadSnapshot(provided, env).then((value) => {
      resolved = value.resolvedConfig;
      return value;
    });
    return snapshotPromise;
  };
  pi.registerCommand("pi-web-kits", {
    description: "Inspect or test pi-web-kits search configuration.",
    getArgumentCompletions: (prefix) => {
      const values = COMMAND_ARGUMENTS.filter((value) => {
        if (!value.startsWith(prefix.trimStart())) return false;
        if (value === "status" || !resolved) return true;
        if (!resolved.enabled || !resolved.search.enabled) return false;
        return resolved.search.sources[
          value === "test github" ? "github" : "web"
        ].enabled;
      });
      return values.length
        ? values.map((value) => ({ value, label: value }))
        : null;
    },
    handler: async (args, ctx) => {
      try {
        const [command, target] = args.trim().split(/\s+/, 2);
        if (command === "status") {
          ctx.ui.notify(statusText(await snapshot(), ctx, env), "info");
        } else if (command === "test") {
          await handleTestCommand(
            target,
            snapshot,
            ctx,
            search,
            searchGitHub,
            env,
          );
        } else {
          ctx.ui.notify(USAGE_TEXT, "info");
        }
      } catch (error) {
        ctx.ui.notify(commandErrorText(error), "error");
      }
    },
  });
}
