import {
  WEB_SEARCH_PROVIDER_NAMES,
  type WebSearchProviderName,
} from "./types.ts";

export const WEB_SEARCH_ERROR_CODES = [
  "invalid-config",
  "request",
  "auth",
  "unsupported",
  "rate-limit",
  "network",
  "timeout",
  "invalid-response",
  "cancelled",
  "server",
] as const;

export type WebSearchErrorCode = (typeof WEB_SEARCH_ERROR_CODES)[number];

export interface SearchAttempt {
  readonly provider: WebSearchProviderName;
  readonly code: WebSearchErrorCode;
}

export interface WebSearchErrorOptions {
  provider?: string;
  status?: number;
  attempts?: readonly SearchAttempt[];
}

/**
 * Errors exposed by the extension are deliberately short and classified.
 * Provider response bodies and request headers must never be copied here:
 * Pi may surface an error message in the transcript or debug diagnostics.
 */
export class WebSearchError extends Error {
  readonly code: WebSearchErrorCode;
  readonly provider?: string;
  readonly status?: number;
  readonly attempts?: readonly SearchAttempt[];

  constructor(
    code: WebSearchErrorCode,
    message: string,
    options: WebSearchErrorOptions = {},
  ) {
    // Boundary code rebuilds this through toWebSearchError before exposing it.
    super(message);
    this.name = "WebSearchError";
    this.code = code;
    this.provider = options.provider;
    this.status = options.status;
    this.attempts = options.attempts?.map(({ provider, code }) => ({
      provider,
      code,
    }));
  }
}

export function errorMessageForCode(
  code: WebSearchErrorCode,
  provider?: string,
): string {
  const label = provider ? `${provider} ` : "";
  switch (code) {
    case "invalid-config":
      return "Web search configuration is invalid.";
    case "request":
      return `${label}rejected the search request.`;
    case "auth":
      return `${label}authentication is unavailable or was rejected.`;
    case "unsupported":
      return `${label}does not support this search request.`;
    case "rate-limit":
      return `${label}rate limit was reached.`;
    case "network":
      return `${label}could not be reached.`;
    case "timeout":
      return `${label}request timed out.`;
    case "invalid-response":
      return `${label}returned an invalid response.`;
    case "cancelled":
      return "Web search was cancelled.";
    case "server":
      return `${label}returned a server error.`;
  }
}

export function errorCodeForStatus(status: number): WebSearchErrorCode {
  if (status === 401 || status === 403) return "auth";
  if (status === 408 || status === 504) return "timeout";
  if (status === 404 || status === 405 || status === 415 || status === 422) {
    return "unsupported";
  }
  if (status === 429) return "rate-limit";
  if (status >= 400 && status < 500) return "request";
  return status >= 500 ? "server" : "invalid-response";
}

export function errorFromStatus(
  status: number,
  provider: string,
): WebSearchError {
  const code = errorCodeForStatus(status);
  return new WebSearchError(code, errorMessageForCode(code, provider), {
    provider,
    status,
  });
}

/** Convert an arbitrary provider failure to a safe, classified error. */
export function toWebSearchError(
  error: unknown,
  provider?: string,
): WebSearchError {
  const classified = error instanceof WebSearchError ? error : undefined;
  const safeProvider = WEB_SEARCH_PROVIDER_NAMES.find(
    (name) => name === (provider ?? classified?.provider),
  );
  let code: WebSearchErrorCode = "network";
  if (classified) {
    code =
      WEB_SEARCH_ERROR_CODES.find((code) => code === classified.code) ??
      "network";
  } else if (error instanceof Error) {
    if (error.name === "AbortError") code = "cancelled";
    else if (/timeout|timed out/i.test(error.name + error.message))
      code = "timeout";
  }
  const attempts = classified?.attempts
    ?.filter(
      (attempt) =>
        WEB_SEARCH_PROVIDER_NAMES.includes(attempt.provider) &&
        WEB_SEARCH_ERROR_CODES.includes(attempt.code),
    )
    .slice(0, 2)
    .map(({ provider, code }) => ({ provider, code }));
  const tried = attempts?.length
    ? ` Tried: ${attempts.map((attempt) => `${attempt.provider} (${attempt.code})`).join(", ")}.`
    : "";
  return new WebSearchError(
    code,
    errorMessageForCode(code, safeProvider) + tried,
    {
      provider: safeProvider,
      status: Number.isInteger(classified?.status)
        ? classified?.status
        : undefined,
      attempts,
    },
  );
}

export function assertNotCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new WebSearchError("cancelled", errorMessageForCode("cancelled"));
  }
}

export function isFallbackEligible(error: WebSearchError): boolean {
  return [
    "auth",
    "unsupported",
    "rate-limit",
    "network",
    "timeout",
    "invalid-response",
    "server",
  ].includes(error.code);
}
