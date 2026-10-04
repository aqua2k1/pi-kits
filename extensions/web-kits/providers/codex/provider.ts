import { randomUUID } from "node:crypto";
import { WebSearchError } from "../../core/errors.ts";
import type {
  SearchProvider,
  SearchRequest,
  SearchResult,
} from "../../core/types.ts";
import {
  type FetchLike,
  fetchJson,
  validateTimeout,
  withSearchDeadline,
} from "../../shared/http.ts";
import { DEFAULT_SEARCH_TIMEOUT_MS } from "../../shared/limits.ts";
import {
  isRecord,
  normalizeSearchResponse,
  stringField,
} from "../../shared/results.ts";
import { buildCodexHeaders, type CodexRequestAuth } from "./auth.ts";
import { normalizeCodexModel } from "./config.ts";

export const CODEX_ALPHA_SEARCH_URL =
  "https://chatgpt.com/backend-api/codex/alpha/search";
const PROVIDER = "codex-alpha-search";

export interface CodexAlphaSearchProviderOptions {
  model?: string;
  timeoutMs?: number;
  resolveAuth: (signal: AbortSignal) => Promise<CodexRequestAuth>;
  fetch?: FetchLike;
  requestId?: () => string;
}

export function buildCodexSearchPayload(
  request: SearchRequest,
  model: string,
  requestId: string,
): Record<string, unknown> {
  return {
    id: requestId,
    model,
    commands: {
      search_query: [
        {
          q: request.query,
          ...(request.recencyDays !== undefined
            ? { recency: request.recencyDays }
            : {}),
          ...(request.domains?.length ? { domains: [...request.domains] } : {}),
        },
      ],
    },
    settings: { allowed_callers: ["direct"], external_web_access: true },
  };
}

function* parseResults(raw: Record<string, unknown>): Iterable<SearchResult> {
  if (Array.isArray(raw.results)) {
    for (const item of raw.results) {
      if (!isRecord(item)) continue;
      yield {
        title: stringField(item, "title", "name"),
        url: stringField(item, "url", "link", "href"),
        snippet: stringField(
          item,
          "snippet",
          "content",
          "description",
          "text",
          "summary",
        ),
      };
    }
  }
  // Structured results take priority; Markdown citations can fill any remaining slots.
  for (const match of stringField(raw, "output").matchAll(
    /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
  )) {
    yield { title: match[1], url: match[2], snippet: "" };
  }
}

export function createCodexProvider(
  options: CodexAlphaSearchProviderOptions,
): SearchProvider {
  const model = normalizeCodexModel(options.model);
  const timeoutMs = validateTimeout(
    options.timeoutMs ?? DEFAULT_SEARCH_TIMEOUT_MS,
  );
  const fetcher = options.fetch ?? globalThis.fetch;
  const requestId = options.requestId ?? randomUUID;
  return {
    async search(request, signal) {
      return withSearchDeadline(
        PROVIDER,
        timeoutMs,
        signal,
        async (deadline) => {
          const auth = await options.resolveAuth(deadline);
          // Pi's provider auth facade currently cannot cancel refresh. Never send a late request.
          deadline.throwIfAborted();
          const raw = await fetchJson(
            fetcher,
            PROVIDER,
            CODEX_ALPHA_SEARCH_URL,
            {
              method: "POST",
              headers: buildCodexHeaders(auth),
              body: JSON.stringify(
                buildCodexSearchPayload(request, model, requestId()),
              ),
              signal: deadline,
            },
          );
          if (!isRecord(raw) || typeof raw.output !== "string") {
            throw new WebSearchError(
              "invalid-response",
              "Codex search returned an invalid response.",
              { provider: PROVIDER },
            );
          }
          return normalizeSearchResponse(
            request,
            parseResults(raw),
            raw.output,
            [auth.accessToken, auth.accountId],
          );
        },
      );
    },
  };
}
