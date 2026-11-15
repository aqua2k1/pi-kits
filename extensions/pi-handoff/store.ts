import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface HandoffMetadata {
  id: string;
  sessionId: string;
  project: string;
  title: string;
  updatedAt: string;
}

export interface Handoff extends HandoffMetadata {
  body: string;
  raw: string;
  path: string;
}

const PREFIX = "<!-- pi-handoff ";

export async function projectPath(cwd: string): Promise<string> {
  return realpath(cwd);
}

export function handoffId(project: string, sessionId: string): string {
  return createHash("sha256")
    .update(JSON.stringify([project, sessionId]))
    .digest("hex")
    .slice(0, 16);
}

export function handoffPath(directory: string, id: string): string {
  if (!/^[a-f0-9]{16}$/u.test(id)) throw new Error("Invalid handoff ID");
  return join(directory, `${id}.md`);
}

export function metadataHeader(metadata: HandoffMetadata): string {
  return `${PREFIX}${JSON.stringify(metadata).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e")} -->`;
}

export async function backupHandoff(
  directory: string,
  document: Handoff,
): Promise<string> {
  const path = join(directory, `.${document.id}.${randomUUID()}.bak`);
  await writeFile(path, document.raw, { flag: "wx", mode: 0o600 });
  return path;
}

export async function readHandoff(
  directory: string,
  id: string,
): Promise<Handoff | undefined> {
  const path = handoffPath(directory, id);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const end = raw.indexOf("\n");
  const header = (end < 0 ? raw : raw.slice(0, end)).replace(/\r$/u, "");
  if (!header.startsWith(PREFIX) || !header.endsWith(" -->"))
    throw new Error(`Invalid handoff metadata: ${id}`);
  const metadata: unknown = JSON.parse(header.slice(PREFIX.length, -4));
  if (!metadata || typeof metadata !== "object")
    throw new Error(`Invalid handoff metadata: ${id}`);
  const fields = metadata as HandoffMetadata;
  if (
    fields.id !== id ||
    ![fields.sessionId, fields.project, fields.title, fields.updatedAt].every(
      (value) => typeof value === "string" && value.length > 0,
    ) ||
    !Number.isFinite(Date.parse(fields.updatedAt))
  ) {
    throw new Error(`Invalid handoff metadata: ${id}`);
  }
  return {
    ...fields,
    body: end < 0 ? "" : raw.slice(end + 1).trim(),
    raw,
    path,
  };
}

export async function listHandoffs(
  directory: string,
  project: string,
): Promise<Handoff[]> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const documents: Handoff[] = [];
  for (const name of names) {
    if (!/^[a-f0-9]{16}\.md$/u.test(name)) continue;
    try {
      const document = await readHandoff(directory, name.slice(0, -3));
      if (document?.project === project) {
        document.updatedAt = (await stat(document.path)).mtime.toISOString();
        documents.push(document);
      }
    } catch {
      // A damaged or concurrently removed file must not hide the remaining list.
    }
  }
  return documents.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function handoffGoal(body: string): string {
  return (
    body
      .split(/^## 下一会话目标\s*$/mu)[1]
      ?.split(/^## /mu)[0]
      ?.trim()
      .split("\n")
      .find((line) => line.trim())
      ?.trim() ?? "Handoff"
  );
}
