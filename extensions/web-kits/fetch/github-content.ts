import { open, readdir, realpath, stat } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import {
  FETCH_FILE_CONTENT_LIMIT_MESSAGE,
  MAX_FETCH_CONTENT_BYTES,
  MAX_GITHUB_README_BYTES,
  MAX_GITHUB_TREE_ENTRIES,
} from "../shared/limits.ts";
import { isBinaryFileName } from "./content.ts";
import type { GitHubUrlInfo } from "./github-url.ts";

const NOISE_DIRECTORIES = new Set([
  "node_modules",
  "vendor",
  ".next",
  "dist",
  "build",
  "__pycache__",
  ".venv",
  "venv",
  ".tox",
  ".mypy_cache",
  ".pytest_cache",
  "target",
  ".gradle",
  ".idea",
  ".vscode",
]);

const ROOT_READMES = [
  "README.md",
  "readme.md",
  "README",
  "README.txt",
  "README.rst",
];
const MAX_CLONE_FILE_BYTES = MAX_FETCH_CONTENT_BYTES - 2 * 1_024;

export interface BoundedFileText {
  text: string;
  truncated: boolean;
}

export interface CloneContentResult {
  text: string;
  title: string;
  contentType: string;
  contentLength?: number;
  repositoryPath: string;
  truncated?: boolean;
}

function prefixForPath(root: string): string {
  return root.endsWith(sep) ? root : `${root}${sep}`;
}

export async function resolveWithinRepo(
  rootPath: string,
  relativePath: string,
): Promise<string | null> {
  const root = resolve(rootPath);
  const candidate = resolve(root, relativePath);
  if (candidate !== root && !candidate.startsWith(prefixForPath(root))) {
    return null;
  }
  try {
    const realRoot = await realpath(root);
    const realCandidate = await realpath(candidate);
    if (
      realCandidate !== realRoot &&
      !realCandidate.startsWith(prefixForPath(realRoot))
    ) {
      return null;
    }
  } catch {
    return null;
  }
  return candidate;
}

async function readBoundedFile(
  filePath: string,
  maxBytes = MAX_FETCH_CONTENT_BYTES,
): Promise<BoundedFileText> {
  const handle = await open(filePath, "r");
  try {
    const chunks: Buffer[] = [];
    let total = 0;
    let truncated = false;
    while (total <= maxBytes) {
      const size = Math.min(64 * 1_024, maxBytes + 1 - total);
      if (size <= 0) {
        truncated = true;
        break;
      }
      const buffer = Buffer.alloc(size);
      const result = await handle.read(buffer, 0, size, null);
      if (result.bytesRead === 0) break;
      const chunk = buffer.subarray(0, result.bytesRead);
      if (total + chunk.byteLength > maxBytes) {
        chunks.push(chunk.subarray(0, maxBytes - total));
        truncated = true;
        total = maxBytes;
        break;
      }
      chunks.push(chunk);
      total += chunk.byteLength;
      if (result.bytesRead < size) break;
    }
    const bytes = Buffer.concat(chunks);
    return {
      text: new TextDecoder("utf-8", { fatal: false }).decode(bytes),
      truncated,
    };
  } finally {
    await handle.close();
  }
}

async function isBinaryFile(filePath: string): Promise<boolean> {
  if (isBinaryFileName(filePath)) return true;
  const handle = await open(filePath, "r");
  try {
    const buffer = Buffer.alloc(512);
    const result = await handle.read(buffer, 0, buffer.byteLength, 0);
    return buffer.subarray(0, result.bytesRead).includes(0);
  } finally {
    await handle.close();
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_024 * 1_024) return `${(bytes / 1_024).toFixed(1)} KiB`;
  return `${(bytes / (1_024 * 1_024)).toFixed(1)} MiB`;
}

async function buildTree(rootPath: string): Promise<string> {
  const entries: string[] = [];
  const visitedDirectories = new Set<string>();

  async function walk(
    directory: string,
    relativeDirectory: string,
  ): Promise<void> {
    if (entries.length >= MAX_GITHUB_TREE_ENTRIES) return;
    try {
      const realDirectory = await realpath(directory);
      if (visitedDirectories.has(realDirectory)) return;
      visitedDirectories.add(realDirectory);
    } catch {
      return;
    }
    let items: string[];
    try {
      items = (await readdir(directory)).sort((a, b) => a.localeCompare(b));
    } catch {
      return;
    }
    for (const item of items) {
      if (entries.length >= MAX_GITHUB_TREE_ENTRIES) return;
      if (item === ".git") continue;
      const relativeItem = relativeDirectory
        ? join(relativeDirectory, item)
        : item;
      const safePath = await resolveWithinRepo(rootPath, relativeItem);
      if (!safePath) {
        entries.push(`${relativeItem}  [outside repository skipped]`);
        continue;
      }
      let info: Awaited<ReturnType<typeof stat>>;
      try {
        info = await stat(safePath);
      } catch {
        continue;
      }
      if (info.isDirectory()) {
        if (NOISE_DIRECTORIES.has(item)) {
          entries.push(`${relativeItem}/  [skipped]`);
          continue;
        }
        entries.push(`${relativeItem}/`);
        await walk(safePath, relativeItem);
      } else {
        entries.push(relativeItem);
      }
    }
  }

  await walk(rootPath, "");
  if (entries.length >= MAX_GITHUB_TREE_ENTRIES) {
    entries.push(`... (truncated at ${MAX_GITHUB_TREE_ENTRIES} entries)`);
  }
  return entries.join("\n");
}

async function buildDirectoryListing(
  rootPath: string,
  relativeDirectory: string,
): Promise<string> {
  const safeDirectory = await resolveWithinRepo(rootPath, relativeDirectory);
  if (!safeDirectory) return "(path escapes repository root)";
  let items: string[];
  try {
    items = (await readdir(safeDirectory)).sort((a, b) => a.localeCompare(b));
  } catch {
    return "(directory not readable)";
  }
  const lines: string[] = [];
  for (const item of items.slice(0, MAX_GITHUB_TREE_ENTRIES)) {
    if (item === ".git") continue;
    const relativeItem = relativeDirectory
      ? join(relativeDirectory, item)
      : item;
    const safePath = await resolveWithinRepo(rootPath, relativeItem);
    if (!safePath) {
      lines.push(`  ${item}  (outside repository)`);
      continue;
    }
    try {
      const info = await stat(safePath);
      lines.push(
        info.isDirectory()
          ? `  ${item}/`
          : `  ${item}  (${formatSize(info.size)})`,
      );
    } catch {
      lines.push(`  ${item}  (unreadable)`);
    }
  }
  if (items.length > MAX_GITHUB_TREE_ENTRIES) {
    lines.push(`  ... (${items.length} entries; listing truncated)`);
  }
  return lines.join("\n");
}

async function readRootReadme(rootPath: string): Promise<string | undefined> {
  for (const name of ROOT_READMES) {
    const path = await resolveWithinRepo(rootPath, name);
    if (!path) continue;
    try {
      const info = await stat(path);
      if (!info.isFile() || (await isBinaryFile(path))) continue;
      const content = await readBoundedFile(path, MAX_GITHUB_README_BYTES);
      return content.truncated
        ? `${content.text}\n\n[README truncated]`
        : content.text;
    } catch {
      // Try the next conventional README name.
    }
  }
  return undefined;
}

async function inspectPath(
  rootPath: string,
  relativePath: string,
): Promise<Awaited<ReturnType<typeof stat>> | null> {
  const safePath = await resolveWithinRepo(rootPath, relativePath);
  if (!safePath) return null;
  try {
    return await stat(safePath);
  } catch {
    return null;
  }
}

export async function generateCloneContent(
  rootPath: string,
  info: GitHubUrlInfo,
): Promise<CloneContentResult> {
  const lines: string[] = [`Repository cloned to: ${rootPath}`, ""];
  const title = info.path
    ? `${info.owner}/${info.repo} - ${info.path}`
    : `${info.owner}/${info.repo}`;

  if (info.type === "root") {
    lines.push("## Structure", await buildTree(rootPath), "");
    const readme = await readRootReadme(rootPath);
    if (readme) lines.push("## README.md", readme, "");
    lines.push(
      "Use read or bash at the repository path above for deeper exploration.",
    );
    return {
      text: lines.join("\n"),
      title,
      contentType: "text/plain",
      repositoryPath: rootPath,
    };
  }

  const target = info.path || "";
  const safePath = await resolveWithinRepo(rootPath, target);
  const infoStat = await inspectPath(rootPath, target);
  if (!safePath || !infoStat) {
    lines.push(`Path ${target || "/"} was not found in the clone.`, "");
    lines.push("## Structure", await buildTree(rootPath), "");
    lines.push(
      "Use read or bash at the repository path above for deeper exploration.",
    );
    return {
      text: lines.join("\n"),
      title,
      contentType: "text/plain",
      repositoryPath: rootPath,
    };
  }

  const targetSize = Number(infoStat.size);
  if (info.type === "tree" || infoStat.isDirectory()) {
    lines.push(
      `## ${target || "/"}`,
      await buildDirectoryListing(rootPath, target),
      "",
    );
    lines.push(
      "Use read or bash at the repository path above for deeper exploration.",
    );
    return {
      text: lines.join("\n"),
      title,
      contentType: "text/plain",
      repositoryPath: rootPath,
      contentLength: targetSize,
    };
  }

  if (await isBinaryFile(safePath)) {
    lines.push(
      `## ${target}`,
      `Binary file (${extname(target).replace(/^\./, "") || "unknown"}, ${formatSize(targetSize)}).`,
      `Use read or bash at the repository path above to inspect it.`,
    );
    return {
      text: lines.join("\n"),
      title,
      contentType: "text/plain",
      repositoryPath: rootPath,
      contentLength: targetSize,
    };
  }

  const content = await readBoundedFile(safePath, MAX_CLONE_FILE_BYTES);
  lines.push(`## ${target}`, content.text);
  if (content.truncated) {
    lines.push("", FETCH_FILE_CONTENT_LIMIT_MESSAGE, `Full file: ${safePath}`);
  }
  lines.push(
    "",
    "Use read or bash at the repository path above for deeper exploration.",
  );
  return {
    text: lines.join("\n"),
    title,
    contentType: "text/plain",
    contentLength: targetSize,
    repositoryPath: rootPath,
    ...(content.truncated ? { truncated: true } : {}),
  };
}
