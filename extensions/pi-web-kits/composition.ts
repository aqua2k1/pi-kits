import type {
  ResolvedWebFetchConfig,
  ResolvedWebSearchConfig,
} from "./config.ts";
import { fetchWeb as routeFetchWeb } from "./fetch/router.ts";
import type { FetchResponse, FetchRuntime } from "./fetch/types.ts";
import { assertNotCancelled, WebSearchError } from "./search/errors.ts";
import { searchGitHub } from "./search/github/service.ts";
import type { GitHubSearchRequest } from "./search/github/types.ts";
import {
  type CodexModelRegistry,
  resolveCodexAuth,
} from "./search/providers/codex/auth.ts";
import { createCodexProvider } from "./search/providers/codex/provider.ts";
import { createSearxngProvider } from "./search/providers/searxng/provider.ts";
import { WebSearchRouter } from "./search/router.ts";
import type {
  RoutedSearchResponse,
  SearchExecutionResponse,
  SearchRequest,
} from "./search/types.ts";
import type { ghRequest } from "./shared/gh-request.ts";
import type { FetchLike } from "./shared/request.ts";

export interface SearchRuntime {
  modelRegistry?: CodexModelRegistry;
  fetch?: FetchLike;
  ghRequest?: typeof ghRequest;
}

/** The only place that assembles concrete search providers. */
export function searchWeb(
  request: SearchRequest,
  config: ResolvedWebSearchConfig,
  runtime: SearchRuntime = {},
  signal?: AbortSignal,
): Promise<RoutedSearchResponse> {
  assertNotCancelled(signal);
  if (!config.enabled || !config.sources.web.enabled) {
    throw new WebSearchError("unsupported", "Web search is disabled.");
  }
  const router = new WebSearchRouter({
    searxng: () =>
      createSearxngProvider({
        baseUrl: config.searxngUrl,
        apiKey: config.searxngApiKey,
        timeoutMs: config.timeoutMs,
        fetch: runtime.fetch,
      }),
    "codex-alpha-search": () =>
      createCodexProvider({
        model: config.codexModel,
        timeoutMs: config.timeoutMs,
        fetch: runtime.fetch,
        resolveAuth: (authSignal) =>
          resolveCodexAuth(runtime.modelRegistry, authSignal),
      }),
  });
  return router.search(
    request,
    {
      provider: config.provider,
      fallback: config.fallback,
      fallbackProvider: config.fallbackProvider,
      providers: config.sources.web.routing,
    },
    signal,
  );
}

export type SearchCapabilityRequest =
  | ({ source: "web" } & SearchRequest)
  | ({ source: "github" } & GitHubSearchRequest);

/** Dispatch by search semantics; only the web capability owns adapter fallback. */
export async function search(
  request: SearchCapabilityRequest,
  config: ResolvedWebSearchConfig,
  runtime: SearchRuntime = {},
  signal?: AbortSignal,
): Promise<SearchExecutionResponse> {
  assertNotCancelled(signal);
  if (!config.enabled)
    throw new WebSearchError("unsupported", "Search is disabled.");
  if (request.source === "web") {
    if ("kind" in request)
      throw new WebSearchError(
        "request",
        "GitHub kind is not a web search parameter.",
      );
    return {
      ...(await searchWeb(request, config, runtime, signal)),
      source: "web",
    };
  }
  if (request.source === "github") {
    if (!config.sources.github.enabled) {
      throw new WebSearchError("unsupported", "GitHub search is disabled.");
    }
    const response = await searchGitHub(
      request,
      { timeoutMs: config.timeoutMs, request: runtime.ghRequest },
      signal,
    );
    return {
      ...response,
      provider: "github-gh",
      source: "github",
      kind: request.kind,
    };
  }
  throw new WebSearchError("request", "A supported search source is required.");
}

export interface FetchWebRequest {
  url: string;
}

export function fetchWeb(
  request: FetchWebRequest,
  config: ResolvedWebFetchConfig,
  runtime: FetchRuntime = {},
  signal?: AbortSignal,
): Promise<FetchResponse> {
  return routeFetchWeb(request, config, runtime, signal);
}
