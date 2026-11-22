import { randomUUID } from "node:crypto";
import { MAX_URL_LENGTH } from "../shared/limits.ts";
import { assertNotCancelled, WebFetchError } from "./errors.ts";
import type {
  FetchHandler,
  FetchRequest,
  FetchResponse,
  FetchRuntime,
} from "./types.ts";

export interface FetchRouteHandlers {
  readonly github: FetchHandler;
  readonly document: (
    request: FetchRequest,
    signal?: AbortSignal,
  ) => Promise<FetchResponse>;
}

export function createFetchRuntime(): FetchRuntime {
  return { now: Date.now, uuid: randomUUID };
}

function parseHttpUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new WebFetchError("invalid-url", "The fetch URL is invalid.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new WebFetchError("blocked-url", "The fetch URL is not supported.");
  }
  if (url.username || url.password) {
    throw new WebFetchError("blocked-url", "The fetch URL is not supported.");
  }
  return url;
}

export function normalizeFetchRequest(request: { url: string }): FetchRequest {
  const rawUrl = request.url.trim();
  if (!rawUrl || rawUrl.length > MAX_URL_LENGTH) {
    throw new WebFetchError("invalid-url", "The fetch URL is invalid.");
  }
  return { url: parseHttpUrl(rawUrl) };
}

/** Only routing policy lives here. Composition owns concrete handler wiring. */
export async function routeFetchWeb(
  request: { url: string },
  handlers: FetchRouteHandlers,
  signal?: AbortSignal,
): Promise<FetchResponse> {
  const normalized = normalizeFetchRequest(request);
  assertNotCancelled(signal);
  const stableRequest: FetchRequest = {
    url: new URL(normalized.url.toString()),
  };
  const githubResponse = await handlers.github.fetch(stableRequest, signal);
  if (githubResponse) return githubResponse;
  return handlers.document(stableRequest, signal);
}
