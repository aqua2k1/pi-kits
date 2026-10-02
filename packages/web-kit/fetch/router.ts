import { randomUUID } from "node:crypto";
import type { ResolvedWebFetchConfig } from "../config.ts";
import { MAX_URL_LENGTH } from "../shared/limits.ts";
import { assertNotCancelled, WebFetchError } from "./errors.ts";
import { GitHubHandler } from "./github.ts";
import { fetchDocument } from "./http.ts";
import type { FetchRequest, FetchResponse, FetchRuntime } from "./types.ts";

export function createFetchRuntime(): FetchRuntime {
  const handlers = new Map<string, import("./github.ts").GitHubHandler>();
  return {
    githubHandlerCache: {
      get: (key) => handlers.get(key),
      set: (key, handler) => handlers.set(key, handler),
    },
    now: Date.now,
    uuid: randomUUID,
  };
}

function githubHandlerFor(
  config: ResolvedWebFetchConfig,
  runtime: FetchRuntime,
): GitHubHandler {
  if (runtime.github) return runtime.github;
  const cache = runtime.githubHandlerCache;
  if (!cache) return new GitHubHandler({ config: config.github, runtime });

  const key = JSON.stringify(config.github);
  const existing = cache.get(key);
  if (existing) return existing;
  const handler = new GitHubHandler({ config: config.github, runtime });
  cache.set(key, handler);
  return handler;
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

export function normalizeFetchRequest(request: {
  url: string;
  raw?: boolean;
}): FetchRequest {
  const rawUrl = request.url.trim();
  if (!rawUrl || rawUrl.length > MAX_URL_LENGTH) {
    throw new WebFetchError("invalid-url", "The fetch URL is invalid.");
  }
  const url = parseHttpUrl(rawUrl);
  return { url, raw: request.raw ?? false };
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
      timeoutMs: config.timeoutMs,
      github: { ...config.github },
    };
    this.runtime = { ...runtime };
    this.github = githubHandlerFor(this.config, this.runtime);
  }

  async fetch(
    request: FetchRequest,
    signal?: AbortSignal,
  ): Promise<FetchResponse> {
    assertNotCancelled(signal);
    const stableRequest: FetchRequest = {
      url: new URL(request.url.toString()),
      raw: request.raw,
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
  request: { url: string; raw?: boolean },
  config: ResolvedWebFetchConfig,
  runtime: FetchRuntime = createFetchRuntime(),
  signal?: AbortSignal,
): Promise<FetchResponse> {
  const normalized = normalizeFetchRequest(request);
  assertNotCancelled(signal);
  return new WebFetchRouter(config, runtime).fetch(normalized, signal);
}
