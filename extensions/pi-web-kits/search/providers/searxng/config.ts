import { SEARXNG_DEFAULT_URL } from "../../../shared/limits.ts";
import { WebSearchError } from "../../errors.ts";
import { isSafeHeaderValue } from "../../validation.ts";

export { SEARXNG_DEFAULT_URL };

function tryParseUrl(raw: string): URL | undefined {
  try {
    return new URL(raw);
  } catch {
    return undefined;
  }
}

export function normalizeSearxngBaseUrl(raw = SEARXNG_DEFAULT_URL): string {
  const url = tryParseUrl(raw.trim());
  if (
    !url ||
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    raw.length > 2_048
  ) {
    throw new WebSearchError(
      "invalid-config",
      "SearXNG URL must be HTTP(S), without credentials, query or fragment.",
      { provider: "searxng" },
    );
  }
  return url.toString().replace(/\/+$/, "");
}

export function validateSearxngAuth(apiKey?: string): void {
  if (!apiKey || isSafeHeaderValue(apiKey, 4_096)) return;
  throw new WebSearchError("invalid-config", "SearXNG Bearer key is invalid.", {
    provider: "searxng",
  });
}
