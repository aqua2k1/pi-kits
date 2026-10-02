export const WEB_SEARCH_PROVIDER_NAMES = [
  "searxng",
  "codex-alpha-search",
] as const;

export type WebSearchProviderName = (typeof WEB_SEARCH_PROVIDER_NAMES)[number];

export interface SearchRequest {
  readonly query: string;
  readonly maxResults: number;
  readonly domains?: readonly string[];
  readonly recencyDays?: number;
}

export interface SearchResult {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
}

/** Providers return sanitized, bounded data, never their raw wire response. */
export interface SearchResponse {
  readonly query: string;
  readonly results: readonly SearchResult[];
  readonly summary?: string;
  readonly truncated?: boolean;
}

/** The router passes a normalized request to each provider. */
export interface SearchProvider {
  search(request: SearchRequest, signal?: AbortSignal): Promise<SearchResponse>;
}

export interface RoutedSearchResponse extends SearchResponse {
  readonly provider: WebSearchProviderName;
}
