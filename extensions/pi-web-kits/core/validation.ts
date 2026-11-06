import {
  MAX_DOMAIN_COUNT,
  MAX_DOMAIN_LENGTH,
  MAX_MAX_RESULTS,
  MAX_QUERY_LENGTH,
  MAX_RECENCY_DAYS,
  MIN_MAX_RESULTS,
} from "../shared/limits.ts";
import { WebSearchError } from "./errors.ts";
import type { SearchRequest } from "./types.ts";

function normalizeDomain(raw: string): string {
  const domain = raw.trim().toLowerCase();
  if (
    !domain ||
    domain.length > MAX_DOMAIN_LENGTH ||
    domain.split(".").some((label) => label.length > 63) ||
    !/^(?:\*\.)?[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/.test(
      domain,
    )
  ) {
    throw new WebSearchError(
      "invalid-config",
      "Each search domain must be a hostname.",
    );
  }
  return domain;
}

export function normalizeSearchRequest(request: SearchRequest): SearchRequest {
  const query = request.query.trim();
  if (!query || query.length > MAX_QUERY_LENGTH) {
    throw new WebSearchError(
      "invalid-config",
      `Search query must contain 1-${MAX_QUERY_LENGTH} characters.`,
    );
  }
  if (
    !Number.isInteger(request.maxResults) ||
    request.maxResults < MIN_MAX_RESULTS ||
    request.maxResults > MAX_MAX_RESULTS
  ) {
    throw new WebSearchError(
      "invalid-config",
      "max_results must be an integer between 1 and 10.",
    );
  }

  const rawDomains = request.domains;
  if (rawDomains && rawDomains.length > MAX_DOMAIN_COUNT) {
    throw new WebSearchError(
      "invalid-config",
      `At most ${MAX_DOMAIN_COUNT} search domains are allowed.`,
    );
  }
  const domains = rawDomains?.map(normalizeDomain);

  const recencyDays = request.recencyDays;
  if (
    recencyDays !== undefined &&
    (!Number.isInteger(recencyDays) ||
      recencyDays < 1 ||
      recencyDays > MAX_RECENCY_DAYS)
  ) {
    throw new WebSearchError(
      "invalid-config",
      `recency_days must be an integer between 1 and ${MAX_RECENCY_DAYS}.`,
    );
  }

  return {
    query,
    maxResults: request.maxResults,
    ...(domains && domains.length > 0
      ? { domains: [...new Set(domains)] }
      : {}),
    ...(recencyDays !== undefined ? { recencyDays } : {}),
  };
}
