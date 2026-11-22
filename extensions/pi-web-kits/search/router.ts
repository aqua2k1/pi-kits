import {
  assertNotCancelled,
  formatSearchAttempts,
  isFallbackEligible,
  type SearchAttempt,
  toWebSearchError,
  WebSearchError,
} from "./errors.ts";
import {
  type RoutedSearchResponse,
  type SearchProvider,
  type SearchRequest,
  WEB_SEARCH_PROVIDER_NAMES,
  type WebSearchProviderName,
} from "./types.ts";
import { normalizeSearchRequest } from "./validation.ts";

export type ProviderFactories = Readonly<
  Record<WebSearchProviderName, () => SearchProvider>
>;

export interface SearchRoute {
  readonly provider: WebSearchProviderName;
  readonly fallback: boolean;
  readonly fallbackProvider?: WebSearchProviderName;
  /** Explicit capability-local execution order. */
  readonly providers?: readonly WebSearchProviderName[];
}

/** Provider inventory owns the available choices; consumers share routing policy. */
export function resolveFallbackProvider(
  provider: WebSearchProviderName,
  configured?: WebSearchProviderName,
  available: readonly WebSearchProviderName[] = WEB_SEARCH_PROVIDER_NAMES,
): WebSearchProviderName | undefined {
  return configured ?? available.find((candidate) => candidate !== provider);
}

function resolveProviderOrder(route: SearchRoute): WebSearchProviderName[] {
  if (route.providers) return [...route.providers];
  const order: WebSearchProviderName[] = [route.provider];
  if (route.fallback) {
    const fallbackProvider = resolveFallbackProvider(
      route.provider,
      route.fallbackProvider,
    );
    if (fallbackProvider && fallbackProvider !== route.provider) {
      order.push(fallbackProvider);
    }
  }
  return order;
}

/** Only routing policy lives here. Factories own configuration and credentials. */
export async function routeWebSearch(
  input: SearchRequest,
  route: SearchRoute,
  providers: ProviderFactories,
  signal?: AbortSignal,
): Promise<RoutedSearchResponse> {
  const request = normalizeSearchRequest(input);
  const order = resolveProviderOrder(route);
  const attempts: SearchAttempt[] = [];
  for (const name of order) {
    assertNotCancelled(signal);
    try {
      const response = await providers[name]().search(request, signal);
      assertNotCancelled(signal);
      // Do not overwrite the provider's redacted query with the raw input.
      return { ...response, provider: name };
    } catch (error) {
      const classified = toWebSearchError(error, name);
      attempts.push({ provider: name, code: classified.code });
      if (name === order.at(-1) || !isFallbackEligible(classified)) {
        throw new WebSearchError(
          classified.code,
          `${classified.message}${formatSearchAttempts(attempts)}`,
          { provider: name, status: classified.status, attempts },
        );
      }
    }
  }
  throw new WebSearchError("unsupported", "No search provider is available.");
}

export function createWebSearchRouter(providers: ProviderFactories) {
  const snapshot: ProviderFactories = { ...providers };
  return {
    search: (
      input: SearchRequest,
      route: SearchRoute,
      signal?: AbortSignal,
    ): Promise<RoutedSearchResponse> =>
      routeWebSearch(input, route, snapshot, signal),
  };
}
