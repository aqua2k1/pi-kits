import { GhRequestError, ghRequest } from "../../shared/gh-request.ts";
import {
  assertNotCancelled,
  errorCodeForStatus,
  errorMessageForCode,
  WEB_SEARCH_ERROR_CODES,
  WebSearchError,
  type WebSearchErrorCode,
} from "../errors.ts";
import { isRecord, normalizeSearchResponse } from "../results.ts";
import { normalizeSearchRequest, validateTimeout } from "../validation.ts";

import {
  GITHUB_SEARCH_KINDS,
  type GitHubSearchOptions,
  type GitHubSearchRequest,
  type GitHubSearchResponse,
} from "./types.ts";

function failure(code: WebSearchErrorCode, status?: number): WebSearchError {
  return new WebSearchError(code, errorMessageForCode(code, "GitHub"), {
    provider: "github-gh",
    status,
  });
}

function requiredString(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw failure("invalid-response");
  }
  return value;
}

function nullableText(value: unknown): string {
  if (value === null) return "";
  if (typeof value !== "string") throw failure("invalid-response");
  return value;
}

function resultUrl(value: unknown): string {
  const raw = requiredString(value);
  try {
    const url = new URL(raw);
    if (
      !raw.startsWith("https://github.com/") ||
      /[\s\\\p{Cc}]/u.test(raw) ||
      url.protocol !== "https:" ||
      url.hostname !== "github.com" ||
      url.port ||
      url.username ||
      url.password
    ) {
      throw failure("invalid-response");
    }
    return url.toString();
  } catch {
    throw failure("invalid-response");
  }
}

function parseItem(
  item: unknown,
  kind: GitHubSearchRequest["kind"],
): GitHubSearchResponse["results"][number] {
  if (!isRecord(item)) throw failure("invalid-response");
  const url = resultUrl(item.html_url);
  switch (kind) {
    case "repositories":
      return {
        title: requiredString(item.full_name),
        url,
        snippet: nullableText(item.description),
      };
    case "code": {
      const name = requiredString(item.name);
      const path = requiredString(item.path);
      if (!isRecord(item.repository)) throw failure("invalid-response");
      const repository = requiredString(item.repository.full_name);
      const fragments: string[] = [];
      if (item.text_matches !== undefined) {
        if (!Array.isArray(item.text_matches))
          throw failure("invalid-response");
        for (const match of item.text_matches) {
          if (!isRecord(match) || typeof match.fragment !== "string") {
            throw failure("invalid-response");
          }
          fragments.push(match.fragment);
        }
      }
      return {
        title: `${repository}: ${name}`,
        url,
        // Even with the text-match media type, matches may be absent. Keep a
        // useful path summary without issuing a second API request.
        snippet: fragments.some((fragment) => fragment.trim())
          ? fragments.join("\n")
          : `${repository}/${path}`,
      };
    }
    case "issues":
    case "pull-requests": {
      const pull = kind === "pull-requests";
      if (
        (pull ? !isRecord(item.pull_request) : "pull_request" in item) ||
        !new RegExp(
          `^/[^/]+/[^/]+/${pull ? "pull" : "issues"}/[1-9]\\d*$`,
        ).test(new URL(url).pathname)
      ) {
        throw failure("invalid-response");
      }
      return {
        title: requiredString(item.title),
        url,
        snippet: nullableText(item.body),
      };
    }
    case "commits": {
      requiredString(item.sha);
      if (!isRecord(item.commit)) throw failure("invalid-response");
      const message = requiredString(item.commit.message);
      return { title: message.split(/\r?\n/, 1)[0], url, snippet: message };
    }
  }
}

function normalizeRequest(request: GitHubSearchRequest): GitHubSearchRequest {
  if (
    !isRecord(request) ||
    !GITHUB_SEARCH_KINDS.includes(request.kind) ||
    typeof request.query !== "string"
  ) {
    throw failure("request");
  }
  if ("domains" in request || "recencyDays" in request) {
    throw failure("unsupported");
  }
  const normalized = normalizeSearchRequest(request);
  if (/[\p{Cc}\p{Cs}]/u.test(normalized.query)) throw failure("request");
  // GitHub owns its query grammar. Do not reject ordinary prose or qualifiers
  // through a partial parser; the selected resource kind is checked on results.
  return {
    kind: request.kind,
    query: normalized.query,
    maxResults: normalized.maxResults,
  };
}

function classify(error: unknown): WebSearchError {
  if (error instanceof WebSearchError) {
    // Rebuild rather than exposing arbitrary messages or diagnostic fields.
    return failure(
      WEB_SEARCH_ERROR_CODES.includes(error.code) ? error.code : "network",
    );
  }
  if (error instanceof GhRequestError) {
    const status =
      Number.isInteger(error.status) &&
      (error.status ?? 0) >= 100 &&
      (error.status ?? 0) <= 599
        ? error.status
        : undefined;
    const code =
      error.code === "status"
        ? errorCodeForStatus(status ?? 0)
        : error.code === "tool-unavailable"
          ? "unsupported"
          : error.code;
    return failure(
      WEB_SEARCH_ERROR_CODES.includes(code) ? code : "network",
      status,
    );
  }
  if (error instanceof Error && error.name === "AbortError") {
    return failure("cancelled");
  }
  return failure("network");
}

/** One read-only REST search via gh; no pagination or web-search fallback. */
export async function searchGitHub(
  request: GitHubSearchRequest,
  options: GitHubSearchOptions,
  signal?: AbortSignal,
): Promise<GitHubSearchResponse> {
  try {
    assertNotCancelled(signal);
    const normalized = normalizeRequest(request);
    const timeoutMs = validateTimeout(options.timeoutMs);
    // Match gh's github.com token precedence without discovering or logging
    // credentials from gh's own config. Snapshot only for local output cleanup.
    const secrets = [process.env.GH_TOKEN, process.env.GITHUB_TOKEN].filter(
      (value): value is string => Boolean(value),
    );
    const kind = normalized.kind;
    const query =
      kind === "issues" || kind === "pull-requests"
        ? `(${normalized.query}) AND is:${kind === "issues" ? "issue" : "pr"}`
        : normalized.query;
    const params = new URLSearchParams({
      q: query,
      per_page: String(normalized.maxResults),
      page: "1",
    });
    if (kind === "issues" || kind === "pull-requests") {
      // Parentheses/AND must be evaluated by the advanced issue search engine.
      params.set("advanced_search", "true");
    }
    const endpoint = `search/${kind === "pull-requests" ? "issues" : kind}?${params}`;
    const raw = await (options.request ?? ghRequest)(endpoint, {
      timeoutMs,
      signal,
      ...(kind === "code"
        ? { accept: "application/vnd.github.text-match+json" as const }
        : {}),
    });
    assertNotCancelled(signal);
    if (
      !isRecord(raw) ||
      !Number.isSafeInteger(raw.total_count) ||
      (raw.total_count as number) < 0 ||
      typeof raw.incomplete_results !== "boolean" ||
      !Array.isArray(raw.items) ||
      raw.items.length > 100 ||
      (raw.total_count as number) < raw.items.length
    ) {
      throw failure("invalid-response");
    }
    // Validate every returned item, not only the first maxResults entries.
    const candidates = raw.items.map((item) => parseItem(item, kind));
    const response = normalizeSearchResponse(
      normalized,
      candidates,
      undefined,
      secrets,
    );
    return {
      ...response,
      ...(raw.incomplete_results ||
      (raw.total_count as number) > response.results.length ||
      candidates.length > response.results.length
        ? { truncated: true }
        : {}),
    };
  } catch (error) {
    if (signal?.aborted) throw failure("cancelled");
    throw classify(error);
  }
}
