const REPOSITORY_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const REF_SEGMENT = /^[^\\:*?"<>|\s]+$/;
const FULL_SHA = /^[0-9a-f]{40}$/i;

export interface GitHubUrlInfo {
  owner: string;
  repo: string;
  ref?: string;
  refIsFullSha: boolean;
  path: string;
  type: "root" | "blob" | "tree";
  /** Decoded URL components whose ref/path boundary needs real refs. */
  unresolvedSegments?: string[];
}

function decodeSegment(segment: string): string | undefined {
  try {
    const decoded = decodeURIComponent(segment);
    return decoded &&
      !decoded.includes("\\") &&
      !Array.from(decoded).some(
        (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
      ) &&
      decoded.split("/").every((part) => part && part !== "." && part !== "..")
      ? decoded
      : undefined;
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
  const tail = segments.slice(3);
  // An encoded slash in the first component explicitly delimits the ref.
  // Otherwise more than one legal boundary must be checked against real refs.
  if (
    !ref.includes("/") &&
    !FULL_SHA.test(ref) &&
    tail.length > (action === "blob" ? 2 : 1)
  ) {
    return {
      owner,
      repo,
      path: "",
      refIsFullSha: false,
      type: action,
      unresolvedSegments: tail,
    };
  }
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
