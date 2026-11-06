import { WebSearchError } from "../../core/errors.ts";
import { isSafeHeaderValue } from "../../shared/http.ts";

export const SEARXNG_DEFAULT_URL = "http://localhost:8080";

export function normalizeSearxngBaseUrl(raw = SEARXNG_DEFAULT_URL): string {
  try {
    const url = new URL(raw.trim());
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      raw.length > 2_048
    )
      throw new Error();
    return url.toString().replace(/\/+$/, "");
  } catch {
    throw new WebSearchError(
      "invalid-config",
      "SearXNG URL must be HTTP(S), without credentials, query or fragment.",
      { provider: "searxng" },
    );
  }
}

export function validateSearxngAuth(apiKey?: string): void {
  if (!apiKey || isSafeHeaderValue(apiKey, 4_096)) return;
  throw new WebSearchError("invalid-config", "SearXNG Bearer key is invalid.", {
    provider: "searxng",
  });
}
