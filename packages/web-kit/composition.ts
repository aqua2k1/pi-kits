import type {
  ResolvedWebFetchConfig,
  ResolvedWebSearchConfig,
} from "./config.ts";
import { WebSearchRouter } from "./core/router.ts";
import type { RoutedSearchResponse, SearchRequest } from "./core/types.ts";
import { fetchWeb as routeFetchWeb } from "./fetch/router.ts";
import type { FetchResponse, FetchRuntime } from "./fetch/types.ts";
import {
  type CodexModelRegistry,
  resolveCodexAuth,
} from "./providers/codex/auth.ts";
import { createCodexProvider } from "./providers/codex/provider.ts";
import { createSearxngProvider } from "./providers/searxng/provider.ts";
import type { FetchLike } from "./shared/http.ts";

export interface SearchRuntime {
  modelRegistry?: CodexModelRegistry;
  fetch?: FetchLike;
}

/** The only place that assembles concrete search providers. */
export function searchWeb(
  request: SearchRequest,
  config: ResolvedWebSearchConfig,
  runtime: SearchRuntime = {},
  signal?: AbortSignal,
): Promise<RoutedSearchResponse> {
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
    },
    signal,
  );
}

export interface FetchWebRequest {
  url: string;
  raw?: boolean;
}

export function fetchWeb(
  request: FetchWebRequest,
  config: ResolvedWebFetchConfig,
  runtime: FetchRuntime = {},
  signal?: AbortSignal,
): Promise<FetchResponse> {
  return routeFetchWeb(request, config, runtime, signal);
}
