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

function source(
  envValue: string | undefined,
  configValue: string | undefined,
  hasDefault: boolean,
): ConfigSource {
  if (envValue?.trim()) return "env";
  if (configValue?.trim()) return "config";
  return hasDefault ? "default" : "none";
}

function statusText(
  snapshot: WebToolsConfigSnapshot,
  ctx: ExtensionCommandContext,
  env: NodeJS.ProcessEnv,
): string {
  const { rawConfig: raw, resolvedConfig: config } = snapshot;
  const searchEnabled = config.enabled && config.search.enabled;
  const fetchEnabled = config.enabled && config.fetch.enabled;
  const search = raw.search ?? {};
  const webEnabled = searchEnabled && config.search.sources.web.enabled;
  const githubEnabled = searchEnabled && config.search.sources.github.enabled;
  const web = search.sources?.web;
  const routing = config.search.sources.web.routing;
  const routingSource = web
    ? web.routing === undefined
      ? "default"
      : "search.sources.web.routing"
    : search.routing === undefined
      ? "default"
      : "search.routing (legacy)";
  const providerSource = web
    ? source(undefined, web.routing?.[0], true)
    : source(undefined, search.routing?.provider, true);
  const fallbackSource = web
    ? source(undefined, web.routing?.[0], true)
    : search.routing?.fallback === undefined
      ? "default"
      : "config";
  const fallbackProvider = routing[1];
  const fallbackProviderSource = web
    ? source(undefined, web.routing?.[1], true)
    : search.routing?.fallbackProvider === undefined
      ? "default"
      : "config";
  const codexModel = web ? web.codex?.model : search.codex?.model;
  const keySource = source(env.SEARXNG_API_KEY, undefined, false);
  let auth = "unavailable";
  try {
    auth = ctx.modelRegistry.getProviderAuthStatus("openai-codex").configured
      ? "configured (OAuth required)"
      : "not configured";
  } catch {
    // Keep status useful when the host registry is unavailable.
  }
  return [
    "Web tools configuration:",
    `  config file: ${snapshot.configPath ?? getConfigPath()}`,
    `  config source: ${snapshot.source ?? "injected"}`,
    `  web-kits: ${config.enabled ? "enabled" : "disabled"}`,
    `  web_search: ${searchEnabled ? "enabled" : "disabled"}`,
    `  web_fetch: ${fetchEnabled ? "enabled" : "disabled"}`,
    `  Web search: ${webEnabled ? "enabled" : "disabled"}`,
    `  GitHub search: ${githubEnabled ? "enabled" : "disabled"} (gh api)`,
    `  search routing: ${routing.join(" -> ")} (${routingSource})`,
    `  search provider: ${PROVIDER_LABELS[config.search.provider]} (${providerSource})`,
    `  search fallback: ${webEnabled && routing.length > 1 ? "enabled" : "disabled"} (${fallbackSource})`,
    `  search fallback provider: ${fallbackProvider ? PROVIDER_LABELS[fallbackProvider] : "none"} (${fallbackProviderSource})`,
    `  search timeout: ${config.search.timeoutMs} ms`,
    `  search default max results: ${config.search.maxResults}`,
    `  SearXNG URL: configured (${source(env.SEARXNG_URL, undefined, true)})`,
    `  SearXNG Bearer key: ${keySource === "none" ? "not set" : `set (${keySource})`}`,
    `  Codex model: configured (${source(undefined, codexModel, true)})`,
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
  const count = response.results.length;
  ctx.ui.notify(
    `${PROVIDER_LABELS[response.provider]} test succeeded (${count} result${count === 1 ? "" : "s"}).`,
    "info",
  );
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
  pi.registerCommand("web-tools", {
    description: "Inspect or test web-tools search configuration.",
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
        const [command, providerValue] = args.trim().split(/\s+/, 2);
        if (command === "status") {
          ctx.ui.notify(statusText(await snapshot(), ctx, env), "info");
        } else if (command === "test") {
          const provider = normalizeProviderName(providerValue);
          const github = providerValue === "github";
          if (!provider && !github) {
            ctx.ui.notify(
              "Choose a test target: searxng, codex-alpha-search or github.",
              "error",
            );
            return;
          }
          const { resolvedConfig } = await snapshot();
          if (!resolvedConfig.enabled || !resolvedConfig.search.enabled) {
            ctx.ui.notify("Web search is disabled by configuration.", "info");
            return;
          }
          if (
            !resolvedConfig.search.sources[github ? "github" : "web"].enabled
          ) {
            ctx.ui.notify(
              `${github ? "GitHub" : "Web"} search is disabled by configuration.`,
              "info",
            );
            return;
          }
          if (github) {
            const response = await searchGitHub(
              {
                source: "github",
                kind: "repositories",
                query: "repo:github/docs",
                maxResults: 1,
              },
              resolvedConfig.search,
              { modelRegistry: ctx.modelRegistry },
              ctx.signal,
            );
            const count = response.results.length;
            ctx.ui.notify(
              `GitHub test succeeded (${count} result${count === 1 ? "" : "s"}).`,
              "info",
            );
          } else if (provider) {
            await testProvider(ctx, provider, resolvedConfig, search);
          }
        } else {
          ctx.ui.notify(
            "/web-tools status\n/web-tools test <searxng|codex-alpha-search|github>",
            "info",
          );
        }
      } catch (error) {
        ctx.ui.notify(commandErrorText(error), "error");
      }
    },
  });
}
