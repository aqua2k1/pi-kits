import { GhRequestError } from "../../shared/gh-request.ts";
import { isRecord } from "../../shared/guards.ts";
import { assertNotCancelled } from "../errors.ts";
import type { GitHubUrlInfo } from "./url.ts";

/** Resolve only a unique ref/path split; never silently choose a shorter ref. */
export async function resolveGitHubRef(
  info: GitHubUrlInfo,
  request: (endpoint: string, signal?: AbortSignal) => Promise<unknown>,
  signal?: AbortSignal,
): Promise<GitHubUrlInfo | null> {
  const segments = info.unresolvedSegments;
  if (!segments) return info;
  const names = new Set<string>();
  for (const namespace of ["heads", "tags"]) {
    let result: unknown;
    try {
      result = await request(
        `repos/${info.owner}/${info.repo}/git/matching-refs/${namespace}/${encodeURIComponent(segments[0] as string)}`,
        signal,
      );
    } catch (error) {
      if (error instanceof GhRequestError && error.status === 404) return null;
      throw error;
    }
    if (!Array.isArray(result)) return null;
    const prefix = `refs/${namespace}/`;
    for (const entry of result) {
      if (
        !isRecord(entry) ||
        typeof entry.ref !== "string" ||
        !entry.ref.startsWith(prefix)
      ) {
        return null;
      }
      names.add(entry.ref.slice(prefix.length));
    }
  }
  assertNotCancelled(signal);
  const matches: { ref: string; path: string }[] = [];
  const lastBoundary = segments.length - (info.type === "blob" ? 1 : 0);
  for (let boundary = 1; boundary <= lastBoundary; boundary++) {
    const ref = segments.slice(0, boundary).join("/");
    if (names.has(ref)) {
      matches.push({ ref, path: segments.slice(boundary).join("/") });
    }
  }
  if (matches.length !== 1) return null;
  const { unresolvedSegments: _unresolved, ...resolved } = info;
  return { ...resolved, ...matches[0] };
}
