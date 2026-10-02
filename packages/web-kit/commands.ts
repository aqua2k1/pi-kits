import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { searchWeb } from "./composition.ts";
import {
  getConfigPath,
  normalizeProviderName,
  type ResolvedWebSearchConfig,
  type ResolvedWebToolsConfig,
  readConfig,
  resolveConfig,
  type WebToolsFileConfig,
} from "./config.ts";
import { errorMessageForCode, toWebSearchError } from "./core/errors.ts";
import type { WebSearchProviderName } from "./core/types.ts";

const PROVIDER_LABELS: Record<WebSearchProviderName, string> = {
  searxng: "SearXNG",
  "codex-alpha-search": "Codex alpha/search",
};
const COMMAND_ARGUMENTS = ["status", "test searxng", "test codex-alpha-search"];
const DEFAULT_SEARCH_QUERY = "pi web search connectivity";
type ConfigSource = "env" | "config" | "default" | "none";

export interface WebToolsConfigSnapshot {
  readonly rawConfig: WebToolsFileConfig;
  readonly resolvedConfig: ResolvedWebToolsConfig;
}

export interface WebToolsCommandDependencies {
  /** The single configuration snapshot loaded during extension startup. */
  config?: WebToolsConfigSnapshot;
  /** Legacy fallback for callers that do not provide a startup snapshot. */
  readConfig?: typeof readConfig;
  search?: typeof searchWeb;
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
  raw: WebToolsFileConfig,
  config: ResolvedWebToolsConfig,
  ctx: ExtensionCommandContext,
  env: NodeJS.ProcessEnv,
): string {
  const search = raw.search ?? {};
  const routing = search.routing ?? {};
  const fallbackSource = routing.fallback === undefined ? "default" : "config";
  const fallbackProvider =
    config.search.fallbackProvider ??
    (config.search.provider === "searxng" ? "codex-alpha-search" : "searxng");
  const fallbackProviderSource =
    routing.fallbackProvider === undefined ? "default" : "config";
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
    `  config file: ${getConfigPath()}`,
    `  search provider: ${PROVIDER_LABELS[config.search.provider]} (${source(undefined, routing.provider, true)})`,
    `  search fallback: ${config.search.fallback ? "enabled" : "disabled"} (${fallbackSource})`,
    `  search fallback provider: ${PROVIDER_LABELS[fallbackProvider]} (${fallbackProviderSource})`,
    `  search timeout: ${config.search.timeoutMs} ms`,
    `  search default max results: ${config.search.maxResults}`,
    `  SearXNG URL: configured (${source(env.SEARXNG_URL, undefined, true)})`,
    `  SearXNG Bearer key: ${keySource === "none" ? "not set" : `set (${keySource})`}`,
    `  Codex model: configured (${source(undefined, search.codex?.model, true)})`,
    `  Codex authentication: ${auth}`,
    `  fetch timeout: ${config.fetch.timeoutMs} ms`,
    `  GitHub fetch: ${config.fetch.github.enabled ? "enabled" : "disabled"}`,
    `  GitHub mode: ${config.fetch.github.mode}`,
    `  GitHub clone threshold: ${config.fetch.github.maxRepoSizeMB} MiB`,
    `  GitHub clone timeout: ${config.fetch.github.cloneTimeoutSeconds} s`,
    "",
    "Search settings are under search; fetch settings are under fetch.",
    "SearXNG URL and credentials are read from environment variables.",
    "GitHub uses gh api or shallow clone when the local commands are available.",
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
  const rawConfig = await (provided.readConfig ?? readConfig)(getConfigPath());
  return { rawConfig, resolvedConfig: resolveConfig(rawConfig, env) };
}

export function registerWebToolsCommand(
  pi: ExtensionAPI,
  provided: WebToolsCommandDependencies = {},
): void {
  const env = { ...(provided.env ?? process.env) };
  const search = provided.search ?? searchWeb;
  let snapshotPromise: Promise<WebToolsConfigSnapshot> | undefined;
  const snapshot = (): Promise<WebToolsConfigSnapshot> => {
    snapshotPromise ??= loadSnapshot(provided, env);
    return snapshotPromise;
  };
  pi.registerCommand("web-tools", {
    description: "Inspect or test web-tools search configuration.",
    getArgumentCompletions: (prefix) => {
      const values = COMMAND_ARGUMENTS.filter((value) =>
        value.startsWith(prefix.trimStart()),
      );
      return values.length
        ? values.map((value) => ({ value, label: value }))
        : null;
    },
    handler: async (args, ctx) => {
      try {
        const [command, providerValue] = args.trim().split(/\s+/, 2);
        if (command === "status") {
          const { rawConfig, resolvedConfig } = await snapshot();
          ctx.ui.notify(
            statusText(rawConfig, resolvedConfig, ctx, env),
            "info",
          );
        } else if (command === "test") {
          const provider = normalizeProviderName(providerValue);
          if (!provider) {
            ctx.ui.notify(
              "Choose a provider: searxng or codex-alpha-search.",
              "error",
            );
            return;
          }
          const { resolvedConfig } = await snapshot();
          await testProvider(ctx, provider, resolvedConfig, search);
        } else {
          ctx.ui.notify(
            "/web-tools status\n/web-tools test <searxng|codex-alpha-search>",
            "info",
          );
        }
      } catch (error) {
        ctx.ui.notify(commandErrorText(error), "error");
      }
    },
  });
}
