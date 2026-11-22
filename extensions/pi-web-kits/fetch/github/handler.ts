import type { ResolvedGitHubFetchConfig } from "../../config.ts";
import { GhRequestError, ghRequest } from "../../shared/gh-request.ts";
import { isRecord } from "../../shared/guards.ts";
import {
  MAX_GITHUB_TREE_ENTRIES,
  TEMP_SPOOL_TTL_MS,
} from "../../shared/limits.ts";
import { isBinaryFileName } from "../content.ts";
import {
  assertNotCancelled,
  toWebFetchError,
  WebFetchError,
} from "../errors.ts";
import { formatDocument } from "../formatters/index.ts";
import { createTempSpool } from "../spool.ts";
import type {
  FetchHandler,
  FetchRequest,
  FetchResponse,
  FetchRuntime,
} from "../types.ts";
import { resolveGitHubRef } from "./refs.ts";
import { encodeGitHubPath, type GitHubUrlInfo, parseGitHubUrl } from "./url.ts";

// The GitHub Contents API returns at most 1,000 directory entries.
const MAX_CONTENTS_API_ENTRIES = 1_000;

function invalidResponse(): never {
  throw new WebFetchError(
    "invalid-response",
    "The GitHub API returned invalid content.",
    { source: "github-gh" },
  );
}

function unsupported(): never {
  throw new WebFetchError(
    "unsupported",
    "The requested GitHub content is unavailable.",
    { source: "github-gh" },
  );
}

function decodeContent(value: Record<string, unknown>): Buffer {
  if (
    typeof value.content !== "string" ||
    (value.encoding !== undefined && value.encoding !== "base64")
  )
    invalidResponse();
  const content = value.content.replace(/\s+/g, "");
  if (content.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(content))
    invalidResponse();
  return Buffer.from(content, "base64");
}

function titleFor(info: GitHubUrlInfo): string {
  return info.path
    ? `${info.owner}/${info.repo} - ${info.path}`
    : `${info.owner}/${info.repo}`;
}

export interface GitHubHandlerOptions {
  config: ResolvedGitHubFetchConfig;
  apiTimeoutMs: number;
  runtime?: FetchRuntime;
}

type GitHubApiRequest = (
  endpoint: string,
  signal?: AbortSignal,
) => Promise<unknown>;

interface GitHubFetchContext {
  readonly request: GitHubApiRequest;
  readonly now: () => number;
}

async function apiJson(
  ctx: GitHubFetchContext,
  endpoint: string,
  signal?: AbortSignal,
  optional = false,
): Promise<unknown> {
  try {
    return await ctx.request(endpoint, signal);
  } catch (error) {
    if (error instanceof GhRequestError && error.status === 404) {
      if (optional) return undefined;
      unsupported();
    }
    throw error;
  }
}

async function formatGitHubFile(
  value: Record<string, unknown>,
  path: string | undefined,
  signal?: AbortSignal,
): Promise<string> {
  const bytes = decodeContent(value);
  if ((path && isBinaryFileName(path)) || bytes.includes(0)) {
    return `Binary file (${bytes.byteLength} B). Use gh or git through bash to inspect it locally.`;
  }
  return formatDocument({
    text: new TextDecoder("utf-8", { fatal: false }).decode(bytes),
    filePath: path,
    signal,
  });
}

async function storeGitHubResponse(
  ctx: GitHubFetchContext,
  request: FetchRequest,
  text: string,
  title: string,
  signal?: AbortSignal,
  alreadyTruncated = false,
): Promise<FetchResponse> {
  assertNotCancelled(signal);
  const spool = await createTempSpool();
  try {
    const bounded = await spool.saveText(text);
    assertNotCancelled(signal);
    const contentLength = Buffer.byteLength(text, "utf8");
    return {
      text: bounded.text,
      title,
      contentType: "text/plain",
      contentLength,
      finalUrl: request.url.toString(),
      source: "github-gh",
      expiresAt: new Date(ctx.now() + TEMP_SPOOL_TTL_MS).toISOString(),
      fullOutputPath: spool.contentPath,
      ...(alreadyTruncated || bounded.truncated
        ? {
            truncation: {
              totalBytes: bounded.totalBytes,
              outputBytes: bounded.outputBytes,
            },
          }
        : {}),
    };
  } catch (error) {
    await spool.cleanup();
    throw error;
  }
}

async function fetchGitHubRoot(
  ctx: GitHubFetchContext,
  info: GitHubUrlInfo,
  request: FetchRequest,
  signal?: AbortSignal,
): Promise<FetchResponse> {
  const base = `repos/${info.owner}/${info.repo}`;
  const repo = await apiJson(ctx, base, signal);
  if (!isRecord(repo)) invalidResponse();
  const description =
    typeof repo.description === "string" ? repo.description : undefined;
  const defaultBranch =
    typeof repo.default_branch === "string" ? repo.default_branch : undefined;
  const lines = [`Repository: ${info.owner}/${info.repo}`];
  if (description) lines.push("", description);
  if (defaultBranch) {
    lines.push("", `Default branch: ${defaultBranch}`);
    const readme = await apiJson(
      ctx,
      `${base}/readme?ref=${encodeURIComponent(defaultBranch)}`,
      signal,
      true,
    );
    if (readme !== undefined) {
      if (!isRecord(readme)) invalidResponse();
      const readmePath =
        typeof readme.path === "string"
          ? readme.path
          : typeof readme.name === "string"
            ? readme.name
            : undefined;
      const text = await formatGitHubFile(readme, readmePath, signal);
      lines.push("", `## ${readmePath ?? "README"}`, text);
    }
  }
  lines.push(
    "",
    "This is a read-only repository overview, not a complete repository. For local exploration, explicitly clone with gh or git through bash.",
  );
  return storeGitHubResponse(
    ctx,
    request,
    lines.join("\n"),
    titleFor(info),
    signal,
  );
}

async function fetchGitHubBlob(
  ctx: GitHubFetchContext,
  info: GitHubUrlInfo,
  ref: string,
  request: FetchRequest,
  signal?: AbortSignal,
): Promise<FetchResponse> {
  const result = await apiJson(
    ctx,
    `repos/${info.owner}/${info.repo}/contents/${encodeGitHubPath(info.path)}?ref=${encodeURIComponent(ref)}`,
    signal,
  );
  if (!isRecord(result) || result.type !== "file") invalidResponse();
  const text = await formatGitHubFile(result, info.path, signal);
  return storeGitHubResponse(ctx, request, text, titleFor(info), signal);
}

async function fetchGitHubTree(
  ctx: GitHubFetchContext,
  info: GitHubUrlInfo,
  ref: string,
  request: FetchRequest,
  signal?: AbortSignal,
): Promise<FetchResponse> {
  const entries = await apiJson(
    ctx,
    `repos/${info.owner}/${info.repo}/contents/${encodeGitHubPath(info.path)}?ref=${encodeURIComponent(ref)}`,
    signal,
  );
  if (!Array.isArray(entries)) invalidResponse();
  const lines = [
    `Directory: ${info.owner}/${info.repo}@${ref}/${info.path}`,
    "",
    "## Entries",
  ];
  for (const entry of entries.slice(0, MAX_GITHUB_TREE_ENTRIES)) {
    if (
      !isRecord(entry) ||
      typeof entry.path !== "string" ||
      typeof entry.type !== "string"
    ) {
      invalidResponse();
    }
    lines.push(`${entry.path}${entry.type === "dir" ? "/" : ""}`);
  }
  if (!entries.length) lines.push("(empty directory)");
  const truncated =
    entries.length >= MAX_CONTENTS_API_ENTRIES ||
    entries.length > MAX_GITHUB_TREE_ENTRIES;
  if (truncated) lines.push("... (directory listing may be truncated)");
  return storeGitHubResponse(
    ctx,
    request,
    lines.join("\n"),
    titleFor(info),
    signal,
    truncated,
  );
}

export function createGitHubFetchHandler(
  options: GitHubHandlerOptions,
): FetchHandler {
  const enabled = options.config.enabled;
  const ctx: GitHubFetchContext = {
    now: options.runtime?.now ?? Date.now,
    request: async (endpoint, signal) => {
      try {
        return await (options.runtime?.ghRequest ?? ghRequest)(endpoint, {
          timeoutMs: options.apiTimeoutMs,
          signal,
        });
      } catch (error) {
        if (error instanceof GhRequestError && error.status === 404) {
          throw error;
        }
        throw toWebFetchError(error);
      }
    },
  };

  return {
    async fetch(
      request: FetchRequest,
      signal?: AbortSignal,
    ): Promise<FetchResponse | null> {
      if (!enabled) return null;
      const stableRequest = { url: new URL(request.url.toString()) };
      const parsed = parseGitHubUrl(stableRequest.url);
      if (!parsed) return null;
      assertNotCancelled(signal);
      const info = await resolveGitHubRef(parsed, ctx.request, signal);
      if (!info) unsupported();
      if (info.type === "root") {
        return fetchGitHubRoot(ctx, info, stableRequest, signal);
      }
      if (!info.ref) unsupported();
      if (info.type === "blob") {
        return fetchGitHubBlob(ctx, info, info.ref, stableRequest, signal);
      }
      return fetchGitHubTree(ctx, info, info.ref, stableRequest, signal);
    },
  };
}
