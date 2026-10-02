import { WebSearchError } from "../../core/errors.ts";
import type {
  SearchProvider,
  SearchRequest,
  SearchResult,
} from "../../core/types.ts";
import {
  type FetchLike,
  fetchJson,
  validateTimeout,
  withSearchDeadline,
} from "../../shared/http.ts";
import { DEFAULT_SEARCH_TIMEOUT_MS } from "../../shared/limits.ts";
import {
  isRecord,
  normalizeSearchResponse,
  stringField,
} from "../../shared/results.ts";
import { normalizeSearxngBaseUrl, validateSearxngAuth } from "./config.ts";

export interface SearxngProviderOptions {
  baseUrl?: string;
  apiKey?: string;
  timeoutMs?: number;
  fetch?: FetchLike;
}

function searchUrl(baseUrl: string, request: SearchRequest): URL {
  const url = new URL(`${baseUrl}/search`);
  const domains = request.domains?.map(
    (domain) => `site:${domain.replace(/^\*\./, "")}`,
  );
  const filter = domains?.length
    ? domains.length === 1
      ? domains[0]
      : `(${domains.join(" OR ")})`
    : "";
  url.searchParams.set("q", [request.query, filter].filter(Boolean).join(" "));
  url.searchParams.set("format", "json");
  url.searchParams.set("safesearch", "0");
  const days = request.recencyDays;
  if (days !== undefined)
    url.searchParams.set(
      "time_range",
      days <= 1 ? "day" : days <= 7 ? "week" : days <= 31 ? "month" : "year",
    );
  return url;
}

function* parseResults(raw: unknown): Iterable<SearchResult> {
  if (!isRecord(raw) || !Array.isArray(raw.results)) {
    throw new WebSearchError(
      "invalid-response",
      "SearXNG returned an invalid response.",
      { provider: "searxng" },
    );
  }
  for (const item of raw.results) {
    if (!isRecord(item)) continue;
    yield {
      title: stringField(item, "title"),
      url: stringField(item, "url"),
      snippet: stringField(item, "content", "snippet", "description"),
    };
  }
}

export function createSearxngProvider(
  options: SearxngProviderOptions = {},
): SearchProvider {
  const baseUrl = normalizeSearxngBaseUrl(options.baseUrl);
  const apiKey = options.apiKey?.trim();
  validateSearxngAuth(apiKey);
  const timeoutMs = validateTimeout(
    options.timeoutMs ?? DEFAULT_SEARCH_TIMEOUT_MS,
  );
  const fetcher = options.fetch ?? globalThis.fetch;
  return {
    async search(request, signal) {
      return withSearchDeadline(
        "searxng",
        timeoutMs,
        signal,
        async (deadline) => {
          const headers = new Headers({ Accept: "application/json" });
          if (apiKey) headers.set("Authorization", `Bearer ${apiKey}`);
          const raw = await fetchJson(
            fetcher,
            "searxng",
            searchUrl(baseUrl, request),
            {
              method: "GET",
              headers,
              signal: deadline,
            },
          );
          return normalizeSearchResponse(
            request,
            parseResults(raw),
            undefined,
            apiKey ? [apiKey] : [],
          );
        },
      );
    },
  };
}
