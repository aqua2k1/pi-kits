import { readFile } from "node:fs/promises";
import {
  getPiKitsConfigPath,
  parsePiKitsFile,
  resolvePiKitsConfig,
} from "@pi-kits/config";
import { errorMessageForCode, WebSearchError } from "./search/errors.ts";
import { SEARXNG_DEFAULT_URL } from "./search/providers/searxng/config.ts";
import { isRecord } from "./search/results.ts";
import {
  WEB_SEARCH_PROVIDER_NAMES,
  type WebSearchProviderName,
} from "./search/types.ts";

export interface WebSearchRouteConfig {
  provider?: string;
  fallback?: boolean;
  fallbackProvider?: string;
}

export interface WebSearchFileConfig {
  enabled?: boolean;
  routing?: WebSearchRouteConfig;
  timeoutMs?: number;
  maxResults?: number;
  codex?: { model?: string };
  sources?: {
    web?: {
      enabled?: boolean;
      routing?: WebSearchProviderName[];
      codex?: { model?: string };
    };
    github?: { enabled?: boolean };
  };
}

export interface GitHubFileConfig {
  enabled?: boolean;
}

export interface WebFetchFileConfig {
  enabled?: boolean;
  timeoutMs?: number;
  github?: GitHubFileConfig;
}

export interface WebToolsFileConfig {
  enabled?: boolean;
  search?: WebSearchFileConfig;
  fetch?: WebFetchFileConfig;
}

export interface ResolvedWebSearchConfig {
  enabled: boolean;
  sources: {
    web: { enabled: boolean; routing: WebSearchProviderName[] };
    github: { enabled: boolean };
  };
  /** @internal Derived compatibility field. */
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
}

export interface ResolvedWebFetchConfig {
  enabled: boolean;
  timeoutMs: number;
  github: ResolvedGitHubFetchConfig;
}

export interface ResolvedWebToolsConfig {
  enabled: boolean;
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
  const enabled = readField<boolean>(source, "enabled", "boolean");
  if (enabled !== undefined) config.enabled = enabled;
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
  if (isRecord(source.sources)) {
    config.sources = {};
    if (isRecord(source.sources.web)) {
      const web = source.sources.web;
      config.sources.web = {
        ...(web.enabled !== undefined
          ? { enabled: web.enabled as boolean }
          : {}),
        ...(web.routing !== undefined
          ? { routing: [...(web.routing as WebSearchProviderName[])] }
          : {}),
        ...(isRecord(web.codex)
          ? {
              codex:
                web.codex.model === undefined
                  ? {}
                  : { model: web.codex.model as string },
            }
          : {}),
      };
    }
    if (isRecord(source.sources.github)) {
      config.sources.github =
        source.sources.github.enabled === undefined
          ? {}
          : { enabled: source.sources.github.enabled as boolean };
    }
  }
  return config;
}

function parseFetchConfig(source: Record<string, unknown>): WebFetchFileConfig {
  const config: WebFetchFileConfig = {};
  const enabled = readField<boolean>(source, "enabled", "boolean");
  if (enabled !== undefined) config.enabled = enabled;
  const timeoutMs = readField<number>(source, "timeoutMs", "number");
  if (timeoutMs !== undefined) config.timeoutMs = timeoutMs;

  if (Object.hasOwn(source, "github")) {
    if (!isRecord(source.github)) invalidField("fetch.github");
    const enabled = readField<boolean>(source.github, "enabled", "boolean");
    config.github = enabled === undefined ? {} : { enabled };
  }
  return config;
}

/** Parse the internal pi-web-kits section, not a complete configuration file. */
export function parseConfig(text: string): WebToolsFileConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    return invalid("Web tools configuration is not valid JSON.");
  }
  if (!isRecord(raw))
    return invalid("Web tools configuration must be an object.");

  try {
    parsePiKitsFile(JSON.stringify({ "pi-web-kits": raw }));
  } catch {
    return invalid("Web tools configuration is invalid.");
  }
  const config: WebToolsFileConfig = {};
  const enabled = readField<boolean>(raw, "enabled", "boolean");
  if (enabled !== undefined) config.enabled = enabled;
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

export function getConfigPath(agentDir?: string): string {
  return getPiKitsConfigPath(agentDir);
}

export interface WebToolsConfigFileSnapshot {
  rawConfig: WebToolsFileConfig;
  configPath: string;
  source: "pi-kits" | "defaults" | "injected";
}

/** Read only the specified unified file; an absent file uses defaults. */
export async function readConfigSnapshot(
  path: string = getConfigPath(),
): Promise<WebToolsConfigFileSnapshot> {
  try {
    const file = parsePiKitsFile(await readFile(path, "utf8"));
    return {
      rawConfig: parseConfig(JSON.stringify(file["pi-web-kits"] ?? {})),
      configPath: path,
      source: "pi-kits",
    };
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return { rawConfig: {}, configPath: path, source: "defaults" };
    }
    if (error instanceof WebSearchError) throw error;
    return invalid("Web tools configuration could not be read or is invalid.");
  }
}

export async function readConfig(
  path: string = getConfigPath(),
): Promise<WebToolsFileConfig> {
  return (await readConfigSnapshot(path)).rawConfig;
}

function resolveShared(config: WebToolsFileConfig) {
  try {
    return resolvePiKitsConfig(
      parsePiKitsFile(JSON.stringify({ "pi-web-kits": config })),
    )["pi-web-kits"];
  } catch {
    return invalid("Web tools configuration is invalid.");
  }
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
  const search = resolveShared({ search: config }).search;
  const searxngUrl = stringValue(env.SEARXNG_URL) ?? SEARXNG_DEFAULT_URL;
  const searxngApiKey = stringValue(env.SEARXNG_API_KEY);
  return {
    enabled: search.enabled,
    sources: {
      web: {
        enabled: search.sources.web.enabled,
        routing: [...search.sources.web.routing],
      },
      github: { ...search.sources.github },
    },
    provider: search.routing.provider,
    fallback: search.routing.fallback,
    ...(search.routing.fallbackProvider
      ? { fallbackProvider: search.routing.fallbackProvider }
      : {}),
    timeoutMs: search.timeoutMs,
    maxResults: search.maxResults,
    searxngUrl,
    ...(searxngApiKey ? { searxngApiKey } : {}),
    codexModel: search.codex.model,
  };
}

export function resolveFetchConfig(
  config: WebFetchFileConfig = {},
): ResolvedWebFetchConfig {
  return resolveShared({ fetch: config }).fetch;
}

export function resolveConfig(
  config: WebToolsFileConfig = {},
  env: NodeJS.ProcessEnv = process.env,
): ResolvedWebToolsConfig {
  return {
    enabled: resolveShared(config).enabled,
    search: resolveSearchConfig(config.search, env),
    fetch: resolveFetchConfig(config.fetch),
  };
}
