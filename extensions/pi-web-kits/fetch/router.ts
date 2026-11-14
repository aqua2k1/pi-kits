import { randomUUID } from "node:crypto";
import type { ResolvedWebFetchConfig } from "../config.ts";
import { MAX_URL_LENGTH } from "../shared/limits.ts";
import { fetchDocument } from "./document.ts";
import { assertNotCancelled, WebFetchError } from "./errors.ts";
import { GitHubHandler } from "./github.ts";
import type { FetchRequest, FetchResponse, FetchRuntime } from "./types.ts";

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
  const url = parseHttpUrl(rawUrl);
  return { url };
}

export class WebFetchRouter {
  private readonly github: GitHubHandler;
  private readonly config: ResolvedWebFetchConfig;
  private readonly runtime: FetchRuntime;

  constructor(
    config: ResolvedWebFetchConfig,
    runtime: FetchRuntime = createFetchRuntime(),
  ) {
    this.config = {
      enabled: config.enabled,
      timeoutMs: config.timeoutMs,
      github: { ...config.github },
    };
    this.runtime = { ...runtime };
    this.github =
      this.runtime.github ??
      new GitHubHandler({
        config: this.config.github,
        apiTimeoutMs: this.config.timeoutMs,
        runtime: this.runtime,
      });
  }

  async fetch(
    request: FetchRequest,
    signal?: AbortSignal,
  ): Promise<FetchResponse> {
    assertNotCancelled(signal);
    const stableRequest: FetchRequest = {
      url: new URL(request.url.toString()),
    };
    const githubResponse = await this.github.fetch(stableRequest, signal);
    if (githubResponse) return githubResponse;

    return fetchDocument(
      stableRequest,
      {
        timeoutMs: this.config.timeoutMs,
        fetch: this.runtime.fetch,
        now: this.runtime.now,
      },
      signal,
    );
  }
}

export async function fetchWeb(
  request: { url: string },
  config: ResolvedWebFetchConfig,
  runtime: FetchRuntime = createFetchRuntime(),
  signal?: AbortSignal,
): Promise<FetchResponse> {
  const normalized = normalizeFetchRequest(request);
  assertNotCancelled(signal);
  return new WebFetchRouter(config, runtime).fetch(normalized, signal);
}
