import {
  WEB_SEARCH_PROVIDER_NAMES,
  type WebSearchProviderName,
} from "./types.ts";

/** Provider inventory owns the available choices; consumers share routing policy. */
export function resolveFallbackProvider(
  provider: WebSearchProviderName,
  configured?: WebSearchProviderName,
  available: readonly WebSearchProviderName[] = WEB_SEARCH_PROVIDER_NAMES,
): WebSearchProviderName | undefined {
  return configured ?? available.find((candidate) => candidate !== provider);
}
