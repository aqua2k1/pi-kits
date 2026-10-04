const REPOSITORY_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const REF_SEGMENT = /^[^\\/:*?"<>|]+$/;
const FULL_SHA = /^[0-9a-f]{40}$/i;

export interface GitHubUrlInfo {
  owner: string;
  repo: string;
  ref?: string;
  refIsFullSha: boolean;
  path: string;
  type: "root" | "blob" | "tree";
}

function decodeSegment(segment: string): string | undefined {
  try {
    const decoded = decodeURIComponent(segment);
    return decoded && decoded !== "." && decoded !== ".." ? decoded : undefined;
  } catch {
    return undefined;
  }
}

function validRepositorySegment(value: string | undefined): value is string {
  return Boolean(value && REPOSITORY_SEGMENT.test(value));
}

export function parseGitHubUrl(url: URL | string): GitHubUrlInfo | null {
  let parsed: URL;
  try {
    parsed = typeof url === "string" ? new URL(url) : url;
  } catch {
    return null;
  }
  if (
    parsed.protocol !== "https:" ||
    (parsed.hostname !== "github.com" &&
      parsed.hostname !== "www.github.com") ||
    parsed.username ||
    parsed.password
  ) {
    return null;
  }

  const segments: string[] = [];
  for (const segment of parsed.pathname.split("/").filter(Boolean)) {
    const decoded = decodeSegment(segment);
    if (!decoded) return null;
    segments.push(decoded);
  }
  if (segments.length < 2) return null;

  const owner = segments[0];
  const repo = segments[1]?.replace(/\.git$/i, "");
  if (!validRepositorySegment(owner) || !validRepositorySegment(repo))
    return null;
  const action = segments[2]?.toLowerCase();
  if (!action) {
    return segments.length === 2
      ? { owner, repo, path: "", refIsFullSha: false, type: "root" }
      : null;
  }
  if (action !== "blob" && action !== "tree") return null;
  const ref = segments[3];
  if (!ref || !REF_SEGMENT.test(ref)) return null;
  const path = segments.slice(4).join("/");
  if (action === "blob" && !path) return null;
  return {
    owner,
    repo,
    ref,
    refIsFullSha: FULL_SHA.test(ref),
    path,
    type: action,
  };
}

export function encodeGitHubPath(path: string): string {
  return path
    .split("/")
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}
