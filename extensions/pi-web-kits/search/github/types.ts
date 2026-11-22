import type { ghRequest } from "../../shared/gh-request.ts";

export const GITHUB_SEARCH_KINDS = [
  "repositories",
  "code",
  "issues",
  "pull-requests",
  "commits",
] as const;

export type GitHubSearchKind = (typeof GITHUB_SEARCH_KINDS)[number];

export interface GitHubSearchRequest {
  readonly kind: GitHubSearchKind;
  readonly query: string;
  /** Integer from 1 to 10, sharing the existing search output budget. */
  readonly maxResults: number;
  readonly domains?: never;
  readonly recencyDays?: never;
}

export interface GitHubSearchResponse {
  readonly query: string;
  readonly results: readonly {
    readonly title: string;
    readonly url: string;
    readonly snippet: string;
  }[];
  readonly truncated?: boolean;
}

export interface GitHubSearchOptions {
  readonly timeoutMs: number;
  readonly request?: typeof ghRequest;
  readonly env?: NodeJS.ProcessEnv;
}
