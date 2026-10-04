export const WEB_FETCH_ERROR_CODES = [
  "invalid-config",
  "invalid-url",
  "blocked-url",
  "request",
  "auth",
  "unsupported",
  "rate-limit",
  "network",
  "timeout",
  "invalid-response",
  "tool-unavailable",
  "cancelled",
] as const;

export type WebFetchErrorCode = (typeof WEB_FETCH_ERROR_CODES)[number];

export interface WebFetchErrorOptions {
  status?: number;
  source?: string;
}

export class WebFetchError extends Error {
  readonly code: WebFetchErrorCode;
  readonly status?: number;
  readonly source?: string;

  constructor(
    code: WebFetchErrorCode,
    message: string,
    options: WebFetchErrorOptions = {},
  ) {
    super(message);
    this.name = "WebFetchError";
    this.code = code;
    this.status = options.status;
    this.source = options.source;
  }
}

export function errorMessageForCode(code: WebFetchErrorCode): string {
  switch (code) {
    case "invalid-config":
      return "Web tools fetch configuration is invalid.";
    case "invalid-url":
      return "The fetch URL is invalid.";
    case "blocked-url":
      return "The fetch URL is not supported.";
    case "request":
      return "The fetch request was rejected.";
    case "auth":
      return "Fetch authentication is unavailable or was rejected.";
    case "unsupported":
      return "The requested content is not supported.";
    case "rate-limit":
      return "The fetch rate limit was reached.";
    case "network":
      return "The fetch target could not be reached.";
    case "timeout":
      return "The fetch request timed out.";
    case "invalid-response":
      return "The fetch target returned an invalid response.";
    case "tool-unavailable":
      return "The required fetch command is unavailable.";
    case "cancelled":
      return "Web fetch was cancelled.";
  }
}

function errorCodeForStatus(status: number): WebFetchErrorCode {
  if (status === 401 || status === 403) return "auth";
  if (status === 408 || status === 504) return "timeout";
  if (status === 404 || status === 405 || status === 415 || status === 422) {
    return "unsupported";
  }
  if (status === 429) return "rate-limit";
  if (status >= 400 && status < 500) return "request";
  return status >= 500 ? "network" : "invalid-response";
}

export function errorFromStatus(
  status: number,
  source?: string,
): WebFetchError {
  const code = errorCodeForStatus(status);
  return new WebFetchError(code, errorMessageForCode(code), {
    status,
    source,
  });
}

export function assertNotCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new WebFetchError("cancelled", errorMessageForCode("cancelled"));
  }
}

export function toWebFetchError(error: unknown): WebFetchError {
  if (error instanceof WebFetchError) {
    return new WebFetchError(error.code, errorMessageForCode(error.code), {
      status: error.status,
      source: error.source,
    });
  }
  if (error instanceof Error) {
    const code = "code" in error ? error.code : undefined;
    if (code === "invalid-config") {
      return new WebFetchError(
        "invalid-config",
        errorMessageForCode("invalid-config"),
      );
    }
    if (code === "cancelled") {
      return new WebFetchError("cancelled", errorMessageForCode("cancelled"));
    }
    if (error.name === "AbortError") {
      return new WebFetchError("cancelled", errorMessageForCode("cancelled"));
    }
    if (/timeout|timed out/i.test(`${error.name} ${error.message}`)) {
      return new WebFetchError("timeout", errorMessageForCode("timeout"));
    }
    if (/enoent|not found/i.test(`${error.name} ${error.message}`)) {
      return new WebFetchError(
        "tool-unavailable",
        errorMessageForCode("tool-unavailable"),
      );
    }
  }
  return new WebFetchError("network", errorMessageForCode("network"));
}
