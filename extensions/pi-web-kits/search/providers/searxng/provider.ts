import { isRecord } from "../../../shared/guards.ts";
import {
  DEFAULT_SEARCH_TIMEOUT_MS,
  MAX_RESPONSE_BYTES,
} from "../../../shared/limits.ts";
import {
  type FetchLike,
  request as httpRequest,
} from "../../../shared/request.ts";
import { toWebSearchError, WebSearchError } from "../../errors.ts";
import { normalizeSearchResponse, stringField } from "../../results.ts";
import type {
  SearchProvider,
  SearchRequest,
  SearchResult,
} from "../../types.ts";
import { validateTimeout } from "../../validation.ts";
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
  return {
    async search(request, signal) {
      try {
        const headers = new Headers({ Accept: "application/json" });
        if (apiKey) headers.set("Authorization", `Bearer ${apiKey}`);
        const raw = await httpRequest(searchUrl(baseUrl, request), {
          method: "GET",
          headers,
          response: "json",
          redirect: "error",
          maxBytes: MAX_RESPONSE_BYTES,
          timeoutMs,
          signal,
          fetch: options.fetch,
        });
        return normalizeSearchResponse(
          request,
          parseResults(raw),
          undefined,
          apiKey ? [apiKey] : [],
        );
      } catch (error) {
        throw toWebSearchError(error, "searxng");
      }
    },
  };
}
