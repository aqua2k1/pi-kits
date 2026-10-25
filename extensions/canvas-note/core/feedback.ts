import type {
  ExtensionAPI,
  ExtensionContext,
  MessageEndEvent,
} from "@earendil-works/pi-coding-agent";
import type { Feedback } from "./types.ts";

type BranchEntries = ReturnType<
  ExtensionContext["sessionManager"]["getBranch"]
>;
type Message = MessageEndEvent["message"];
interface InboxState {
  received: Set<string>;
  pending: Map<string, Feedback>;
}

function emptyState(): InboxState {
  return { received: new Set(), pending: new Map() };
}

function feedbackText(feedback: Feedback): string {
  const text = `Canvas Note 用户回复 [${feedback.requestId}]（以下 JSON 包含用户所选内容的完整快照；按 block.id 使用 update_blocks 修正内容）：\n${JSON.stringify(feedback)}`;
  return text;
}

function pendingMessage(
  pending: ReadonlyMap<string, Feedback>,
  prompt: string | undefined,
) {
  const awaiting = [...pending.values()].filter(
    (feedback) => feedbackText(feedback) !== prompt,
  );
  if (!awaiting.length) return;
  const text = `Canvas Note 已接收但尚未交付的用户回复。请结合所选内容处理：\n${JSON.stringify(awaiting)}`;
  return {
    message: {
      customType: "canvas-note-feedback-pending",
      content: text,
      display: true,
      details: { ids: awaiting.map((feedback) => feedback.requestId) },
    },
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
  pending: ReadonlyMap<string, Feedback>,
): string[] {
  if (message.role === "user") {
    const value = messageText(message);
    return [...pending]
      .filter(([, feedback]) => feedbackText(feedback) === value)
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

function restoredState(entries: BranchEntries): InboxState {
  const state = emptyState();
  for (const entry of entries) {
    if (entry.type !== "custom") continue;
    if (entry.customType === "canvas-note-feedback") {
      const feedback = entry.data as Feedback;
      if (typeof feedback?.requestId === "string") {
        state.received.add(feedback.requestId);
        state.pending.set(feedback.requestId, feedback);
      }
    } else if (entry.customType === "canvas-note-feedback-delivered") {
      for (const id of stringIds(entry.data)) state.pending.delete(id);
    }
  }
  return state;
}

/** A browser ACK means accepted into the session, not that model inference succeeded. */
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
    restore(ctx: ExtensionContext) {
      state = restoredState(ctx.sessionManager.getBranch());
    },
    accept(feedback: Feedback) {
      if (state.received.has(feedback.requestId)) return;
      const text = feedbackText(feedback);
      // Persist before acknowledging. A rejected prompt (e.g. compaction) remains recoverable.
      pi.appendEntry("canvas-note-feedback", feedback);
      state.received.add(feedback.requestId);
      state.pending.set(feedback.requestId, feedback);
      pi.sendUserMessage(text, {
        deliverAs: "followUp",
        expandPromptTemplates: false,
      });
    },
    clear() {
      state = emptyState();
    },
  };
}
