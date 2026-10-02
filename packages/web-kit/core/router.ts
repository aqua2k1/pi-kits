import {
  assertNotCancelled,
  isFallbackEligible,
  type SearchAttempt,
  toWebSearchError,
  WebSearchError,
} from "./errors.ts";
import type {
  RoutedSearchResponse,
  SearchProvider,
  SearchRequest,
  WebSearchProviderName,
} from "./types.ts";
import { normalizeSearchRequest } from "./validation.ts";

export type ProviderFactories = Readonly<
  Record<WebSearchProviderName, () => SearchProvider>
>;

export interface SearchRoute {
  readonly provider: WebSearchProviderName;
  readonly fallback: boolean;
  readonly fallbackProvider?: WebSearchProviderName;
}

/** Only routing policy lives here. Factories own configuration and credentials. */
export class WebSearchRouter {
  private readonly providers: ProviderFactories;

  constructor(providers: ProviderFactories) {
    this.providers = { ...providers };
  }

  async search(
    input: SearchRequest,
    route: SearchRoute,
    signal?: AbortSignal,
  ): Promise<RoutedSearchResponse> {
    const request = normalizeSearchRequest(input);
    const order: WebSearchProviderName[] = [route.provider];
    if (route.fallback) {
      const fallbackProvider =
        route.fallbackProvider ??
        (route.provider === "searxng" ? "codex-alpha-search" : "searxng");
      if (fallbackProvider !== route.provider) order.push(fallbackProvider);
    }
    const attempts: SearchAttempt[] = [];
    for (const name of order) {
      assertNotCancelled(signal);
      try {
        const response = await this.providers[name]().search(request, signal);
        assertNotCancelled(signal);
        // Do not overwrite the provider's redacted query with the raw input.
        return { ...response, provider: name };
      } catch (error) {
        const classified = toWebSearchError(error, name);
        attempts.push({ provider: name, code: classified.code });
        if (name === order.at(-1) || !isFallbackEligible(classified)) {
          throw new WebSearchError(
            classified.code,
            `${classified.message} Tried: ${attempts.map((attempt) => `${attempt.provider} (${attempt.code})`).join(", ")}.`,
            { provider: name, status: classified.status, attempts },
          );
        }
      }
    }
    throw new WebSearchError("unsupported", "No search provider is available.");
  }
}
