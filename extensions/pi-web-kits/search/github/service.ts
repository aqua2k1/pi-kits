import { GhRequestError, ghRequest } from "../../shared/gh-request.ts";
import { isRecord } from "../../shared/guards.ts";
import {
  assertNotCancelled,
  errorCodeForStatus,
  errorMessageForCode,
  WEB_SEARCH_ERROR_CODES,
  WebSearchError,
  type WebSearchErrorCode,
} from "../errors.ts";
import { normalizeSearchResponse } from "../results.ts";
import { normalizeSearchRequest, validateTimeout } from "../validation.ts";

import {
  GITHUB_SEARCH_KINDS,
  type GitHubSearchOptions,
  type GitHubSearchRequest,
  type GitHubSearchResponse,
} from "./types.ts";

const ISSUE_PATH_PATTERN = /^\/[^/]+\/[^/]+\/issues\/[1-9]\d*$/;
const PULL_PATH_PATTERN = /^\/[^/]+\/[^/]+\/pull\/[1-9]\d*$/;
const MAX_GITHUB_SEARCH_ITEMS = 100;

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

function parseCodeItem(
  item: Record<string, unknown>,
  url: string,
): GitHubSearchResponse["results"][number] {
  const name = requiredString(item.name);
  const path = requiredString(item.path);
  if (!isRecord(item.repository)) throw failure("invalid-response");
  const repository = requiredString(item.repository.full_name);
  const fragments: string[] = [];
  if (item.text_matches !== undefined) {
    if (!Array.isArray(item.text_matches)) throw failure("invalid-response");
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

function parseIssueOrPullItem(
  item: Record<string, unknown>,
  url: string,
  kind: "issues" | "pull-requests",
): GitHubSearchResponse["results"][number] {
  const isPull = kind === "pull-requests";
  const pathPattern = isPull ? PULL_PATH_PATTERN : ISSUE_PATH_PATTERN;
  if (
    (isPull ? !isRecord(item.pull_request) : "pull_request" in item) ||
    !pathPattern.test(new URL(url).pathname)
  ) {
    throw failure("invalid-response");
  }
  return {
    title: requiredString(item.title),
    url,
    snippet: nullableText(item.body),
  };
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
    case "code":
      return parseCodeItem(item, url);
    case "issues":
    case "pull-requests":
      return parseIssueOrPullItem(item, url, kind);
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

function buildSearchEndpoint(request: GitHubSearchRequest): string {
  const { kind } = request;
  const isIssueKind = kind === "issues" || kind === "pull-requests";
  const query = isIssueKind
    ? `(${request.query}) AND is:${kind === "issues" ? "issue" : "pr"}`
    : request.query;
  const params = new URLSearchParams({
    q: query,
    per_page: String(request.maxResults),
    page: "1",
  });
  if (isIssueKind) {
    // Parentheses/AND must be evaluated by the advanced issue search engine.
    params.set("advanced_search", "true");
  }
  return `search/${kind === "pull-requests" ? "issues" : kind}?${params}`;
}

function parseSearchEnvelope(raw: unknown): {
  totalCount: number;
  incompleteResults: boolean;
  items: unknown[];
} {
  if (
    !isRecord(raw) ||
    typeof raw.total_count !== "number" ||
    !Number.isSafeInteger(raw.total_count) ||
    raw.total_count < 0 ||
    typeof raw.incomplete_results !== "boolean" ||
    !Array.isArray(raw.items) ||
    raw.items.length > MAX_GITHUB_SEARCH_ITEMS ||
    raw.total_count < raw.items.length
  ) {
    throw failure("invalid-response");
  }
  return {
    totalCount: raw.total_count,
    incompleteResults: raw.incomplete_results,
    items: raw.items,
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
    const env = options.env ?? process.env;
    const secrets = [env.GH_TOKEN, env.GITHUB_TOKEN].filter(
      (value): value is string => Boolean(value),
    );
    const raw = await (options.request ?? ghRequest)(
      buildSearchEndpoint(normalized),
      {
        timeoutMs,
        signal,
        ...(normalized.kind === "code"
          ? { accept: "application/vnd.github.text-match+json" as const }
          : {}),
      },
    );
    assertNotCancelled(signal);
    const { totalCount, incompleteResults, items } = parseSearchEnvelope(raw);
    // Validate every returned item, not only the first maxResults entries.
    const candidates = items.map((item) => parseItem(item, normalized.kind));
    const response = normalizeSearchResponse(
      normalized,
      candidates,
      undefined,
      secrets,
    );
    const truncated =
      incompleteResults ||
      totalCount > response.results.length ||
      candidates.length > response.results.length;
    return {
      ...response,
      ...(truncated ? { truncated: true } : {}),
    };
  } catch (error) {
    if (signal?.aborted) throw failure("cancelled");
    throw classify(error);
  }
}
