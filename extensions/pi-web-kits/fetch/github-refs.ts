import { assertNotCancelled, WebFetchError } from "./errors.ts";
import type { GhClient } from "./gh-client.ts";
import type { GitHubUrlInfo } from "./github-url.ts";

/** Resolve only a unique ref/path split; never silently choose a shorter ref. */
export async function resolveGitHubRef(
  info: GitHubUrlInfo,
  gh: Pick<GhClient, "apiJson">,
  signal?: AbortSignal,
): Promise<GitHubUrlInfo | null> {
  const segments = info.unresolvedSegments;
  if (!segments) return info;
  const names = new Set<string>();
  try {
    for (const namespace of ["heads", "tags"]) {
      const result = await gh.apiJson(
        `repos/${info.owner}/${info.repo}/git/matching-refs/${namespace}/${encodeURIComponent(segments[0] as string)}`,
        signal,
      );
      if (!result || !Array.isArray(result.value)) return null;
      for (const entry of result.value) {
        if (
          !entry ||
          typeof entry !== "object" ||
          typeof entry.ref !== "string" ||
          !entry.ref.startsWith(`refs/${namespace}/`)
        )
          return null;
        names.add(entry.ref.slice(`refs/${namespace}/`.length));
      }
    }
  } catch (error) {
    assertNotCancelled(signal);
    if (error instanceof WebFetchError && error.code !== "cancelled")
      return null;
    throw error;
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
