import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { errorMessageForCode, WebSearchError } from "./core/errors.ts";
import {
  WEB_SEARCH_PROVIDER_NAMES,
  type WebSearchProviderName,
} from "./core/types.ts";
import { CODEX_DEFAULT_MODEL } from "./providers/codex/config.ts";
import { SEARXNG_DEFAULT_URL } from "./providers/searxng/config.ts";
import {
  DEFAULT_FETCH_TIMEOUT_MS,
  DEFAULT_GITHUB_CLONE_PATH,
  DEFAULT_GITHUB_CLONE_TIMEOUT_SECONDS,
  DEFAULT_GITHUB_ENABLED,
  DEFAULT_GITHUB_MAX_REPO_SIZE_MB,
  DEFAULT_MAX_RESULTS,
  DEFAULT_SEARCH_TIMEOUT_MS,
  MAX_FETCH_TIMEOUT_MS,
  MAX_GITHUB_CLONE_TIMEOUT_SECONDS,
  MAX_GITHUB_REPO_SIZE_MB,
  MAX_MAX_RESULTS,
  MAX_SEARCH_TIMEOUT_MS,
  MIN_FETCH_TIMEOUT_MS,
  MIN_GITHUB_CLONE_TIMEOUT_SECONDS,
  MIN_GITHUB_REPO_SIZE_MB,
  MIN_MAX_RESULTS,
  MIN_SEARCH_TIMEOUT_MS,
} from "./shared/limits.ts";
import { isRecord } from "./shared/results.ts";

export const WEB_TOOLS_CONFIG_FILE = "web-tools-config.json";

export interface WebSearchRouteConfig {
  provider?: string;
  fallback?: boolean;
  fallbackProvider?: string;
}

export interface WebSearchFileConfig {
  routing?: WebSearchRouteConfig;
  timeoutMs?: number;
  maxResults?: number;
  codex?: { model?: string };
}

export type GitHubFetchMode = "auto" | "clone" | "api";

export interface GitHubFileConfig {
  enabled?: boolean;
  mode?: GitHubFetchMode;
  maxRepoSizeMB?: number;
  cloneTimeoutSeconds?: number;
  clonePath?: string;
}

export interface WebFetchFileConfig {
  timeoutMs?: number;
  github?: GitHubFileConfig;
}

export interface WebToolsFileConfig {
  search?: WebSearchFileConfig;
  fetch?: WebFetchFileConfig;
}

export interface ResolvedWebSearchConfig {
  provider: WebSearchProviderName;
  fallback: boolean;
  fallbackProvider?: WebSearchProviderName;
  timeoutMs: number;
  maxResults: number;
  searxngUrl: string;
  searxngApiKey?: string;
  codexModel: string;
}

export interface ResolvedGitHubFetchConfig {
  enabled: boolean;
  mode: GitHubFetchMode;
  maxRepoSizeMB: number;
  cloneTimeoutSeconds: number;
  clonePath: string;
}

export interface ResolvedWebFetchConfig {
  timeoutMs: number;
  github: ResolvedGitHubFetchConfig;
}

export interface ResolvedWebToolsConfig {
  search: ResolvedWebSearchConfig;
  fetch: ResolvedWebFetchConfig;
}

const INVALID_CONFIG = errorMessageForCode("invalid-config");
type FieldKind = "string" | "boolean" | "number";

function invalid(message: string): never {
  throw new WebSearchError("invalid-config", message);
}

function invalidField(field: string): never {
  return invalid(`${INVALID_CONFIG} ${field} has an invalid type.`);
}

function readField<T>(
  record: Record<string, unknown>,
  field: string,
  kind: FieldKind,
): T | undefined {
  if (!Object.hasOwn(record, field)) return undefined;
  const value = record[field];
  if (typeof value !== kind || (kind === "number" && !Number.isFinite(value))) {
    invalidField(field);
  }
  return value as T;
}

function parseSearchConfig(
  source: Record<string, unknown>,
): WebSearchFileConfig {
  const config: WebSearchFileConfig = {};
  const timeoutMs = readField<number>(source, "timeoutMs", "number");
  const maxResults = readField<number>(source, "maxResults", "number");
  if (timeoutMs !== undefined) config.timeoutMs = timeoutMs;
  if (maxResults !== undefined) config.maxResults = maxResults;

  if (Object.hasOwn(source, "routing")) {
    if (!isRecord(source.routing)) invalidField("search.routing");
    const routing = source.routing;
    const provider = readField<string>(routing, "provider", "string");
    const fallback = readField<boolean>(routing, "fallback", "boolean");
    const fallbackProvider = readField<string>(
      routing,
      "fallbackProvider",
      "string",
    );
    config.routing = {
      ...(provider !== undefined ? { provider } : {}),
      ...(fallback !== undefined ? { fallback } : {}),
      ...(fallbackProvider !== undefined ? { fallbackProvider } : {}),
    };
  }

  if (Object.hasOwn(source, "searxng")) {
    if (!isRecord(source.searxng)) invalidField("search.searxng");
    if (
      Object.hasOwn(source.searxng, "url") ||
      Object.hasOwn(source.searxng, "apiKey")
    ) {
      invalid(
        "SearXNG URL and API key must be configured through SEARXNG_URL and SEARXNG_API_KEY.",
      );
    }
  }

  if (Object.hasOwn(source, "codex")) {
    if (!isRecord(source.codex)) invalidField("search.codex");
    const model = readField<string>(source.codex, "model", "string");
    config.codex = model === undefined ? {} : { model };
  }
  return config;
}

function parseFetchConfig(source: Record<string, unknown>): WebFetchFileConfig {
  const config: WebFetchFileConfig = {};
  const timeoutMs = readField<number>(source, "timeoutMs", "number");
  if (timeoutMs !== undefined) config.timeoutMs = timeoutMs;

  if (Object.hasOwn(source, "github")) {
    if (!isRecord(source.github)) invalidField("fetch.github");
    const enabled = readField<boolean>(source.github, "enabled", "boolean");
    const mode = readField<string>(source.github, "mode", "string");
    const maxRepoSizeMB = readField<number>(
      source.github,
      "maxRepoSizeMB",
      "number",
    );
    const cloneTimeoutSeconds = readField<number>(
      source.github,
      "cloneTimeoutSeconds",
      "number",
    );
    const clonePath = readField<string>(source.github, "clonePath", "string");
    config.github = {
      ...(enabled !== undefined ? { enabled } : {}),
      ...(mode !== undefined ? { mode: mode as GitHubFetchMode } : {}),
      ...(maxRepoSizeMB !== undefined ? { maxRepoSizeMB } : {}),
      ...(cloneTimeoutSeconds !== undefined ? { cloneTimeoutSeconds } : {}),
      ...(clonePath !== undefined ? { clonePath } : {}),
    };
  }
  return config;
}

export function parseConfig(text: string): WebToolsFileConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    return invalid("Web tools configuration is not valid JSON.");
  }
  if (!isRecord(raw))
    return invalid("Web tools configuration must be an object.");

  for (const legacyField of [
    "routing",
    "timeoutMs",
    "maxResults",
    "codex",
    "searxng",
  ]) {
    if (Object.hasOwn(raw, legacyField)) {
      invalid(`${INVALID_CONFIG} ${legacyField} must be nested under search.`);
    }
  }

  const config: WebToolsFileConfig = {};
  if (Object.hasOwn(raw, "search")) {
    if (!isRecord(raw.search)) invalidField("search");
    config.search = parseSearchConfig(raw.search);
  }
  if (Object.hasOwn(raw, "fetch")) {
    if (!isRecord(raw.fetch)) invalidField("fetch");
    config.fetch = parseFetchConfig(raw.fetch);
  }
  return config;
}

export function getConfigPath(agentDir: string = getAgentDir()): string {
  return join(agentDir, WEB_TOOLS_CONFIG_FILE);
}

export async function readConfig(
  path: string = getConfigPath(),
): Promise<WebToolsFileConfig> {
  try {
    return parseConfig(await readFile(path, "utf8"));
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return {};
    }
    if (error instanceof WebSearchError) throw error;
    return invalid("Web tools configuration could not be read.");
  }
}

function parseInteger(
  value: number,
  name: string,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    return invalid(
      `${INVALID_CONFIG} ${name} must be an integer between ${minimum} and ${maximum}.`,
    );
  }
  return value;
}

function stringValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

export function normalizeProviderName(
  value: string | undefined,
): WebSearchProviderName | undefined {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  const candidate = normalized === "codex" ? "codex-alpha-search" : normalized;
  return (WEB_SEARCH_PROVIDER_NAMES as readonly string[]).includes(candidate)
    ? (candidate as WebSearchProviderName)
    : undefined;
}

export function resolveSearchConfig(
  config: WebSearchFileConfig = {},
  env: NodeJS.ProcessEnv = process.env,
): ResolvedWebSearchConfig {
  const routing = config.routing ?? {};
  const configuredProvider = stringValue(routing.provider);
  const provider = configuredProvider
    ? normalizeProviderName(configuredProvider)
    : "searxng";
  if (!provider) {
    return invalid(
      `${INVALID_CONFIG} search.routing.provider must be searxng or codex-alpha-search.`,
    );
  }

  const configuredFallbackProvider = stringValue(routing.fallbackProvider);
  const fallbackProvider = configuredFallbackProvider
    ? normalizeProviderName(configuredFallbackProvider)
    : undefined;
  if (configuredFallbackProvider && !fallbackProvider) {
    return invalid(
      `${INVALID_CONFIG} search.routing.fallbackProvider must be searxng or codex-alpha-search.`,
    );
  }
  if (fallbackProvider === provider) {
    return invalid(
      `${INVALID_CONFIG} search.routing.fallbackProvider must differ from search.routing.provider.`,
    );
  }

  const timeoutMs = parseInteger(
    config.timeoutMs ?? DEFAULT_SEARCH_TIMEOUT_MS,
    "search.timeoutMs",
    MIN_SEARCH_TIMEOUT_MS,
    MAX_SEARCH_TIMEOUT_MS,
  );
  const maxResults = parseInteger(
    config.maxResults ?? DEFAULT_MAX_RESULTS,
    "search.maxResults",
    MIN_MAX_RESULTS,
    MAX_MAX_RESULTS,
  );
  const searxngUrl = stringValue(env.SEARXNG_URL) ?? SEARXNG_DEFAULT_URL;
  const searxngApiKey = stringValue(env.SEARXNG_API_KEY);
  const codexModel = stringValue(config.codex?.model) ?? CODEX_DEFAULT_MODEL;

  return {
    provider,
    fallback: routing.fallback ?? false,
    ...(fallbackProvider ? { fallbackProvider } : {}),
    timeoutMs,
    maxResults,
    searxngUrl,
    ...(searxngApiKey ? { searxngApiKey } : {}),
    codexModel,
  };
}

export function resolveFetchConfig(
  config: WebFetchFileConfig = {},
): ResolvedWebFetchConfig {
  const timeoutMs = parseInteger(
    config.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS,
    "fetch.timeoutMs",
    MIN_FETCH_TIMEOUT_MS,
    MAX_FETCH_TIMEOUT_MS,
  );
  const github = config.github ?? {};
  const mode = github.mode ?? "auto";
  if (mode !== "auto" && mode !== "clone" && mode !== "api") {
    return invalid(`${INVALID_CONFIG} fetch.github.mode is invalid.`);
  }
  const maxRepoSizeMB = parseInteger(
    github.maxRepoSizeMB ?? DEFAULT_GITHUB_MAX_REPO_SIZE_MB,
    "fetch.github.maxRepoSizeMB",
    MIN_GITHUB_REPO_SIZE_MB,
    MAX_GITHUB_REPO_SIZE_MB,
  );
  const cloneTimeoutSeconds = parseInteger(
    github.cloneTimeoutSeconds ?? DEFAULT_GITHUB_CLONE_TIMEOUT_SECONDS,
    "fetch.github.cloneTimeoutSeconds",
    MIN_GITHUB_CLONE_TIMEOUT_SECONDS,
    MAX_GITHUB_CLONE_TIMEOUT_SECONDS,
  );
  const configuredClonePath = stringValue(github.clonePath);

  return {
    timeoutMs,
    github: {
      enabled: github.enabled ?? DEFAULT_GITHUB_ENABLED,
      mode,
      maxRepoSizeMB,
      cloneTimeoutSeconds,
      clonePath: configuredClonePath ?? DEFAULT_GITHUB_CLONE_PATH,
    },
  };
}

export function resolveConfig(
  config: WebToolsFileConfig = {},
  env: NodeJS.ProcessEnv = process.env,
): ResolvedWebToolsConfig {
  return {
    search: resolveSearchConfig(config.search, env),
    fetch: resolveFetchConfig(config.fetch),
  };
}
