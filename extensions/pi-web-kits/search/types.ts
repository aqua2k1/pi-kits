import type { Static } from "typebox";
import type { GitHubSearchKind } from "./github/types.ts";
import type {
  SearchBackendName,
  SearchResultSchema,
  WebSearchProviderName,
} from "./schema.ts";

export {
  SEARCH_BACKEND_NAMES,
  type SearchBackendName,
  WEB_SEARCH_PROVIDER_NAMES,
  type WebSearchProviderName,
} from "./schema.ts";

export type SearchSource = "web" | "github";

export interface SearchRequest {
  readonly query: string;
  readonly maxResults: number;
  readonly domains?: readonly string[];
  readonly recencyDays?: number;
}

export type SearchResult = Readonly<Static<typeof SearchResultSchema>>;

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

/** The tool boundary combines results, not capability-specific input contracts. */
export interface SearchExecutionResponse extends SearchResponse {
  readonly provider: SearchBackendName;
  readonly source?: SearchSource;
  readonly kind?: GitHubSearchKind;
}
