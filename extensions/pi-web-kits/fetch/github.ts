import type { ResolvedGitHubFetchConfig } from "../config.ts";
import {
  MAX_GITHUB_TREE_ENTRIES,
  TEMP_SPOOL_TTL_MS,
} from "../shared/limits.ts";
import { isBinaryFileName } from "./content.ts";
import { assertNotCancelled, WebFetchError } from "./errors.ts";
import { formatDocument } from "./formatters/index.ts";
import { GhClient } from "./gh-client.ts";
import { resolveGitHubRef } from "./github-refs.ts";
import {
  encodeGitHubPath,
  type GitHubUrlInfo,
  parseGitHubUrl,
} from "./github-url.ts";
import { createTempSpool } from "./spool.ts";
import type {
  FetchHandler,
  FetchRequest,
  FetchResponse,
  FetchRuntime,
} from "./types.ts";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

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

export class GitHubHandler implements FetchHandler {
  private readonly enabled: boolean;
  private readonly gh: GhClient;
  private readonly now: () => number;

  constructor(options: GitHubHandlerOptions) {
    this.enabled = options.config.enabled;
    this.now = options.runtime?.now ?? Date.now;
    this.gh = new GhClient({
      command: options.runtime?.command,
      timeoutMs: options.apiTimeoutMs,
    });
  }

  async fetch(
    request: FetchRequest,
    signal?: AbortSignal,
  ): Promise<FetchResponse | null> {
    if (!this.enabled) return null;
    const stableRequest = { url: new URL(request.url.toString()) };
    const parsed = parseGitHubUrl(stableRequest.url);
    if (!parsed) return null;
    assertNotCancelled(signal);
    const info = await resolveGitHubRef(parsed, this.gh, signal);
    if (!info) unsupported();
    const base = `repos/${info.owner}/${info.repo}`;
    if (info.type === "root") {
      const metadata = await this.gh.repoMetadata(
        info.owner,
        info.repo,
        signal,
      );
      if (!metadata) unsupported();
      const lines = [`Repository: ${info.owner}/${info.repo}`];
      if (metadata.description) lines.push("", metadata.description);
      if (metadata.defaultBranch) {
        lines.push("", `Default branch: ${metadata.defaultBranch}`);
        const readme = await this.gh.apiJson(
          `${base}/readme?ref=${encodeURIComponent(metadata.defaultBranch)}`,
          signal,
        );
        if (readme) {
          if (!record(readme.value)) invalidResponse();
          const value = readme.value;
          const path =
            typeof value.path === "string"
              ? value.path
              : typeof value.name === "string"
                ? value.name
                : undefined;
          const text = await this.formatFile(value, path, signal);
          lines.push("", `## ${path ?? "README"}`, text);
        }
      }
      lines.push(
        "",
        "This is a read-only repository overview, not a complete repository. For local exploration, explicitly clone with gh or git through bash.",
      );
      return this.storeResponse(
        stableRequest,
        lines.join("\n"),
        titleFor(info),
        signal,
      );
    }

    if (!info.ref) unsupported();
    const result = await this.gh.apiJson(
      `${base}/contents/${encodeGitHubPath(info.path ?? "")}?ref=${encodeURIComponent(info.ref)}`,
      signal,
    );
    if (!result) unsupported();
    if (info.type === "blob") {
      if (!record(result.value) || result.value.type !== "file")
        invalidResponse();
      const text = await this.formatFile(result.value, info.path, signal);
      return this.storeResponse(stableRequest, text, titleFor(info), signal);
    }

    if (!Array.isArray(result.value)) invalidResponse();
    const entries = result.value;
    const lines = [
      `Directory: ${info.owner}/${info.repo}@${info.ref}/${info.path ?? ""}`,
      "",
      "## Entries",
    ];
    for (const entry of entries.slice(0, MAX_GITHUB_TREE_ENTRIES)) {
      if (
        !record(entry) ||
        typeof entry.path !== "string" ||
        typeof entry.type !== "string"
      )
        invalidResponse();
      lines.push(`${entry.path}${entry.type === "dir" ? "/" : ""}`);
    }
    if (!entries.length) lines.push("(empty directory)");
    // The Contents API returns at most 1,000 directory entries.
    const truncated =
      entries.length >= 1_000 || entries.length > MAX_GITHUB_TREE_ENTRIES;
    if (truncated) lines.push("... (directory listing may be truncated)");
    return this.storeResponse(
      stableRequest,
      lines.join("\n"),
      titleFor(info),
      signal,
      truncated,
    );
  }

  private async formatFile(
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

  private async storeResponse(
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
        expiresAt: new Date(this.now() + TEMP_SPOOL_TTL_MS).toISOString(),
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
}
