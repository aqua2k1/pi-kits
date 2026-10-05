import { closeSync, openSync, unlinkSync, writeFileSync } from "node:fs";
import {
  type ExtensionContext,
  type FileEntry,
  SessionManager,
} from "@earendil-works/pi-coding-agent";

/** Frozen at invocation, before queueing; never clone a moving session file. */
export interface ParentSessionSnapshot {
  entries: FileEntry[];
  sourcePath?: string;
  sessionDir?: string;
}

export function captureParentSession(
  session: ExtensionContext["sessionManager"],
): ParentSessionSnapshot | undefined {
  const branch = session.getBranch();
  if (!branch.length) return undefined;
  const header = session.getHeader();
  if (!header) throw new Error("Cannot clone parent session without a header.");
  return {
    // Match native JSONL serialization, including extension details/toJSON.
    entries: JSON.parse(JSON.stringify([header, ...branch])) as FileEntry[],
    sourcePath: session.getSessionFile(),
    sessionDir: session.getSessionDir() || undefined,
  };
}

/** Remove only unresolved calls from model context, retaining the raw clone.
 * The parent assistant's spawn call cannot have a result until this tool returns.
 * Apply edits to the copy, never mutate parent entries or fake tool results.
 */
function omitPendingCalls(session: SessionManager): void {
  const projection = session.buildSessionProjection();
  const completed = new Set(
    projection.messages.flatMap((message) =>
      message.role === "toolResult" ? [message.toolCallId] : [],
    ),
  );
  for (const entry of projection.entries) {
    if (entry.sourceEntry.type !== "message") continue;
    for (const message of entry.messages) {
      if (message.role !== "assistant") continue;
      const content = message.content.filter(
        (block) => block.type !== "toolCall" || completed.has(block.id),
      );
      if (content.length === message.content.length) continue;
      const hasContent = content.some(
        (block) =>
          block.type === "toolCall" ||
          (block.type === "text" && block.text.trim()),
      );
      session.appendContextEdit(
        entry.sourceEntry.id,
        hasContent ? { content } : null,
      );
    }
  }
}

/** Pi's native branch-cloning logic on an independent SessionManager.
 * No AgentSession is created here; the child CLI opens the resulting JSONL.
 * Clones are private, persistent Pi session files, like ordinary worker logs.
 */
export function createClonedSession(
  snapshot: ParentSessionSnapshot,
  cwd: string,
  id: string,
): string {
  const copy = SessionManager.inMemory(
    cwd,
    undefined,
    structuredClone(snapshot.entries),
  );
  const leaf = copy.getLeafId();
  if (!leaf) throw new Error("Cannot clone an empty parent branch.");
  copy.createBranchedSession(leaf);
  omitPendingCalls(copy);
  const target = SessionManager.create(cwd, snapshot.sessionDir, { id });
  const header = target.getHeader();
  const file = target.getSessionFile();
  if (!header || !file) throw new Error("Cloned session has no file/header.");
  const entries: FileEntry[] = [
    { ...header, parentSession: snapshot.sourcePath },
    ...copy.getEntries(),
  ];
  const fd = openSync(file, "wx", 0o600);
  try {
    for (const entry of entries)
      writeFileSync(fd, `${JSON.stringify(entry)}\n`);
  } catch (error) {
    // Only unlink the file successfully created by this call, never an EEXIST path.
    unlinkSync(file);
    throw error;
  } finally {
    closeSync(fd);
  }
  return file;
}
