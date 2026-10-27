import { MessageKind } from "../core/contracts.js";
import type { Document } from "../core/model.ts";
import type { Feedback } from "../core/types.ts";

export interface ReplyMessage {
  requestId: string;
  version: number;
  blockIds: string[];
  pageIds?: string[];
  reply: string;
}

export function parseClientMessage(raw: string): Record<string, unknown> {
  const message: unknown = JSON.parse(raw);
  if (!message || typeof message !== "object")
    throw new Error("Invalid message");
  return message as Record<string, unknown>;
}

export function parseReply(message: Record<string, unknown>): ReplyMessage {
  const { requestId, version, blockIds, pageIds = [], reply } = message;
  if (
    message.type !== MessageKind.Reply ||
    typeof requestId !== "string" ||
    !requestId ||
    requestId.length > 128 ||
    !Number.isInteger(version) ||
    !Array.isArray(blockIds) ||
    !Array.isArray(pageIds) ||
    (blockIds.length === 0 && pageIds.length === 0) ||
    pageIds.length > 100 ||
    !pageIds.every((id: unknown) => typeof id === "string" && !!id.trim()) ||
    new Set(pageIds).size !== pageIds.length ||
    blockIds.length > 100 ||
    !blockIds.every((id: unknown) => typeof id === "string") ||
    new Set(blockIds).size !== blockIds.length ||
    typeof reply !== "string" ||
    !reply.trim() ||
    reply.length > 20000
  )
    throw new Error("Invalid reply");
  return { requestId, version: version as number, blockIds, pageIds, reply };
}

export function replyFingerprint(message: ReplyMessage): string {
  const fields: unknown[] = [message.version, message.blockIds, message.reply];
  // Keep omitted and empty page scopes equivalent for legacy retries.
  if (message.pageIds?.length) fields.push(message.pageIds);
  return JSON.stringify(fields);
}

export function feedbackForDocument(
  message: ReplyMessage,
  doc: Document,
): Feedback {
  if (message.version !== doc.version)
    throw new Error("内容已更新，请关闭回复窗口并重新选择内容后提交。");
  const all = doc.pages.flatMap((page) =>
    page.blocks.map((block) => ({
      pageId: page.id,
      pageTitle: page.title,
      block,
    })),
  );
  const blocks = message.blockIds.map((id) => {
    const found = all.find((item) => item.block.id === id);
    if (!found) throw new Error(`Unknown blockId: ${id}`);
    return found;
  });
  const pageIds = message.pageIds ?? [];
  const pages = pageIds.map((id) => {
    const found = doc.pages.find((page) => page.id === id);
    if (!found) throw new Error(`Unknown pageId: ${id}`);
    return found;
  });
  return {
    requestId: message.requestId,
    version: doc.version,
    reply: message.reply,
    blocks,
    pageIds,
    pages,
  };
}

export function renderErrorForDocument(
  message: Record<string, unknown>,
  doc: Document,
) {
  if (
    message.version !== doc.version ||
    typeof message.blockId !== "string" ||
    typeof message.message !== "string" ||
    !doc.pages.some((page) =>
      page.blocks.some((block) => block.id === message.blockId),
    )
  )
    return;
  return {
    key: `${message.version}:${message.blockId}`,
    error: {
      version: doc.version,
      blockId: message.blockId,
      message: message.message.slice(0, 2000),
    },
  };
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
