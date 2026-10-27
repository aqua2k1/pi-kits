import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  type ExtensionAPI,
  type ExtensionContext,
  type MessageEndEvent,
  withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { savedDocumentId } from "./presentation.ts";
import type { Feedback } from "./types.ts";

type BranchEntries = ReturnType<
  ExtensionContext["sessionManager"]["getBranch"]
>;
type Message = MessageEndEvent["message"];
interface FeedbackReference {
  requestId: string;
  version: number;
  reply: string;
  blockIds: string[];
  pageIds?: string[];
  snapshotPath: string;
  documentPath: string;
}
interface InboxState {
  received: Set<string>;
  pending: Map<string, FeedbackReference>;
}

function emptyState(): InboxState {
  return { received: new Set(), pending: new Map() };
}

function feedbackText(feedback: FeedbackReference): string {
  return `Canvas Note user feedback [${feedback.requestId}]. Read snapshotPath with the read tool when selected content is needed. Answer questions directly; when changes are requested, check documentPath for current content and use update_blocks with blockId.\n${JSON.stringify(feedback)}`;
}

function matchesFeedbackText(
  feedback: FeedbackReference,
  text: string | undefined,
) {
  if (feedbackText(feedback) === text) return true;
  // A queued follow-up from before page selection may omit the empty scope.
  if (!feedback.pageIds?.length) {
    const { pageIds: _pageIds, ...legacy } = feedback;
    return feedbackText(legacy) === text;
  }
  return false;
}

function pendingMessage(
  pending: ReadonlyMap<string, FeedbackReference>,
  prompt: string | undefined,
) {
  const awaiting = [...pending.values()].filter(
    (feedback) => !matchesFeedbackText(feedback, prompt),
  );
  if (!awaiting.length) return;
  return {
    message: {
      customType: "canvas-note-feedback-pending",
      content: `Canvas Note pending user feedback:\n${awaiting.map(feedbackText).join("\n\n")}`,
      display: true,
      details: { ids: awaiting.map((feedback) => feedback.requestId) },
    },
  };
}

async function saveFeedback(
  feedback: Feedback,
  documentPath: string,
): Promise<FeedbackReference> {
  const name = /^[a-zA-Z0-9_-]{1,128}$/.test(feedback.requestId)
    ? feedback.requestId
    : createHash("sha256").update(feedback.requestId).digest("hex");
  const snapshotPath = join(dirname(documentPath), `feedback-${name}.json`);
  const content = `${JSON.stringify(feedback, null, 2)}\n`;
  await withFileMutationQueue(snapshotPath, async () => {
    try {
      const existing = await readFile(snapshotPath, "utf8");
      if (existing !== content)
        throw new Error(
          `Conflicting feedback requestId: ${feedback.requestId}`,
        );
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await mkdir(dirname(snapshotPath), { recursive: true });
    const temporary = `${snapshotPath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, content, { mode: 0o600 });
      await rename(temporary, snapshotPath);
    } finally {
      await rm(temporary, { force: true });
    }
  });
  return {
    requestId: feedback.requestId,
    version: feedback.version,
    reply: feedback.reply,
    blockIds: feedback.blocks.map(({ block }) => {
      const id = (block as { id?: unknown } | null)?.id;
      if (typeof id !== "string") throw new Error("Invalid feedback block ID");
      return id;
    }),
    pageIds: feedback.pageIds ?? feedback.pages?.map((page) => page.id) ?? [],
    snapshotPath,
    documentPath,
  };
}

function messageText(message: Extract<Message, { role: "user" }>): string {
  const content = message.content;
  return typeof content === "string"
    ? content
    : content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n");
}

function stringIds(details: unknown): string[] {
  const ids = (details as { ids?: unknown } | undefined)?.ids;
  return Array.isArray(ids)
    ? ids.filter((id): id is string => typeof id === "string")
    : [];
}

function deliveredIds(
  message: Message,
  pending: ReadonlyMap<string, FeedbackReference>,
): string[] {
  if (message.role === "user") {
    const value = messageText(message);
    return [...pending]
      .filter(([, feedback]) => matchesFeedbackText(feedback, value))
      .map(([id]) => id);
  }
  if (
    message.role === "custom" &&
    message.customType === "canvas-note-feedback-pending"
  ) {
    return stringIds(message.details).filter((id) => pending.has(id));
  }
  return [];
}

function restoredState(entries: BranchEntries) {
  const received = new Set<string>();
  const pending = new Map<string, FeedbackReference | Feedback>();
  for (const entry of entries) {
    if (entry.type !== "custom") continue;
    if (entry.customType === "canvas-note-feedback") {
      const feedback = entry.data as FeedbackReference | Feedback;
      if (typeof feedback?.requestId === "string") {
        received.add(feedback.requestId);
        pending.set(feedback.requestId, feedback);
      }
    } else if (entry.customType === "canvas-note-feedback-delivered") {
      for (const id of stringIds(entry.data)) pending.delete(id);
    }
  }
  return { received, pending };
}

/** A browser ACK means the snapshot and session reference are durable, not that inference succeeded. */
export function createFeedbackInbox(pi: ExtensionAPI) {
  let state = emptyState();
  function delivered(ids: string[]) {
    if (!ids.length) return;
    pi.appendEntry("canvas-note-feedback-delivered", { ids });
    for (const id of ids) state.pending.delete(id);
  }
  pi.on("before_agent_start", (event) =>
    pendingMessage(state.pending, event.prompt),
  );
  pi.on("message_end", (event) =>
    delivered(deliveredIds(event.message, state.pending)),
  );
  return {
    async restore(ctx: ExtensionContext) {
      const entries = ctx.sessionManager.getBranch();
      const restored = restoredState(entries);
      const pending = new Map<string, FeedbackReference>();
      for (const [id, feedback] of restored.pending) {
        if ("snapshotPath" in feedback) {
          pending.set(id, { ...feedback, pageIds: feedback.pageIds ?? [] });
          continue;
        }
        const documentId = savedDocumentId(entries);
        if (!documentId)
          throw new Error(
            "Missing Canvas Note document identity for legacy feedback",
          );
        const reference = await saveFeedback(
          feedback,
          join(ctx.cwd, "docs", "canvas-notes", documentId, "doc.json"),
        );
        pi.appendEntry("canvas-note-feedback", reference);
        pending.set(id, reference);
      }
      state = { received: restored.received, pending };
    },
    async accept(feedback: Feedback, documentPath: string) {
      // Serialize persistence and deduplication, including simultaneous retries.
      return withFileMutationQueue(
        join(dirname(documentPath), ".feedback-inbox"),
        async () => {
          if (state.received.has(feedback.requestId)) return;
          const reference = await saveFeedback(feedback, documentPath);
          pi.appendEntry("canvas-note-feedback", reference);
          state.received.add(feedback.requestId);
          state.pending.set(feedback.requestId, reference);
          pi.sendUserMessage(feedbackText(reference), {
            deliverAs: "followUp",
            expandPromptTemplates: false,
          });
        },
      );
    },
    clear() {
      state = emptyState();
    },
  };
}
