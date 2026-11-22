import { readFile } from "node:fs/promises";
import {
  getPiKitsConfigPath,
  parsePiKitsFile,
  resolvePiKitsConfig,
} from "@pi-kits/config";
import { errorMessageForCode, WebSearchError } from "./search/errors.ts";
import {
  WEB_SEARCH_PROVIDER_NAMES,
  type WebSearchProviderName,
} from "./search/types.ts";
import { isEnoentError, isRecord } from "./shared/guards.ts";
import { SEARXNG_DEFAULT_URL } from "./shared/limits.ts";

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

function readRecordField(
  record: Record<string, unknown>,
  field: string,
  fieldPath: string = field,
): Record<string, unknown> | undefined {
  if (!Object.hasOwn(record, field)) return undefined;
  const value = record[field];
  if (!isRecord(value)) invalidField(fieldPath);
  return value;
}

function parseSearchRoutingConfig(
  routing: Record<string, unknown>,
): WebSearchRouteConfig {
  const provider = readField<string>(routing, "provider", "string");
  const fallback = readField<boolean>(routing, "fallback", "boolean");
  const fallbackProvider = readField<string>(
    routing,
    "fallbackProvider",
    "string",
  );
  return {
    ...(provider !== undefined ? { provider } : {}),
    ...(fallback !== undefined ? { fallback } : {}),
    ...(fallbackProvider !== undefined ? { fallbackProvider } : {}),
  };
}

function parseCodexSection(codex: Record<string, unknown>): { model?: string } {
  const model = readField<string>(codex, "model", "string");
  return model === undefined ? {} : { model };
}

function parseSearchSourcesConfig(
  sources: Record<string, unknown>,
): NonNullable<WebSearchFileConfig["sources"]> {
  const web = isRecord(sources.web) ? sources.web : undefined;
  const github = isRecord(sources.github) ? sources.github : undefined;
  const webEnabled = web
    ? readField<boolean>(web, "enabled", "boolean")
    : undefined;
  const githubEnabled = github
    ? readField<boolean>(github, "enabled", "boolean")
    : undefined;
  return {
    ...(web
      ? {
          web: {
            ...(webEnabled !== undefined ? { enabled: webEnabled } : {}),
            ...(Array.isArray(web.routing)
              ? { routing: [...(web.routing as WebSearchProviderName[])] }
              : {}),
            ...(isRecord(web.codex)
              ? { codex: parseCodexSection(web.codex) }
              : {}),
          },
        }
      : {}),
    ...(github
      ? {
          github: githubEnabled === undefined ? {} : { enabled: githubEnabled },
        }
      : {}),
  };
}

function parseSearchConfig(
  source: Record<string, unknown>,
): WebSearchFileConfig {
  const searxng = readRecordField(source, "searxng", "search.searxng");
  if (
    searxng &&
    (Object.hasOwn(searxng, "url") || Object.hasOwn(searxng, "apiKey"))
  ) {
    invalid(
      "SearXNG URL and API key must be configured through SEARXNG_URL and SEARXNG_API_KEY.",
    );
  }
  const enabled = readField<boolean>(source, "enabled", "boolean");
  const timeoutMs = readField<number>(source, "timeoutMs", "number");
  const maxResults = readField<number>(source, "maxResults", "number");
  const routing = readRecordField(source, "routing", "search.routing");
  const codex = readRecordField(source, "codex", "search.codex");
  return {
    ...(enabled !== undefined ? { enabled } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(maxResults !== undefined ? { maxResults } : {}),
    ...(routing ? { routing: parseSearchRoutingConfig(routing) } : {}),
    ...(codex ? { codex: parseCodexSection(codex) } : {}),
    ...(isRecord(source.sources)
      ? { sources: parseSearchSourcesConfig(source.sources) }
      : {}),
  };
}

function parseFetchConfig(source: Record<string, unknown>): WebFetchFileConfig {
  const enabled = readField<boolean>(source, "enabled", "boolean");
  const timeoutMs = readField<number>(source, "timeoutMs", "number");
  const github = readRecordField(source, "github", "fetch.github");
  const githubEnabled = github
    ? readField<boolean>(github, "enabled", "boolean")
    : undefined;
  return {
    ...(enabled !== undefined ? { enabled } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(github
      ? {
          github: githubEnabled === undefined ? {} : { enabled: githubEnabled },
        }
      : {}),
  };
}

function extractConfigSection(
  raw: Record<string, unknown>,
): WebToolsFileConfig {
  const enabled = readField<boolean>(raw, "enabled", "boolean");
  const search = readRecordField(raw, "search");
  const fetch = readRecordField(raw, "fetch");
  return {
    ...(enabled !== undefined ? { enabled } : {}),
    ...(search ? { search: parseSearchConfig(search) } : {}),
    ...(fetch ? { fetch: parseFetchConfig(fetch) } : {}),
  };
}

/** Parse the internal pi-web-kits section, not a complete configuration file. */
export function parseConfig(text: string): WebToolsFileConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    return invalid("Web tools configuration is not valid JSON.");
  }
  if (!isRecord(raw)) {
    return invalid("Web tools configuration must be an object.");
  }
  try {
    parsePiKitsFile(JSON.stringify({ "pi-web-kits": raw }));
  } catch {
    return invalid("Web tools configuration is invalid.");
  }
  return extractConfigSection(raw);
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
    const section = file["pi-web-kits"];
    return {
      rawConfig: isRecord(section) ? extractConfigSection(section) : {},
      configPath: path,
      source: "pi-kits",
    };
  } catch (error) {
    if (isEnoentError(error)) {
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

function toResolvedSearchConfig(
  search: ReturnType<typeof resolveShared>["search"],
  env: NodeJS.ProcessEnv,
): ResolvedWebSearchConfig {
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

export function resolveSearchConfig(
  config: WebSearchFileConfig = {},
  env: NodeJS.ProcessEnv = process.env,
): ResolvedWebSearchConfig {
  return toResolvedSearchConfig(resolveShared({ search: config }).search, env);
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
  const shared = resolveShared(config);
  return {
    enabled: shared.enabled,
    search: toResolvedSearchConfig(shared.search, env),
    fetch: shared.fetch,
  };
}
