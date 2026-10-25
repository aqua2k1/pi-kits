import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { RenderErrorReport } from "./types.ts";

type BranchEntries = ReturnType<
  ExtensionContext["sessionManager"]["getBranch"]
>;
const DOCUMENT_ID = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z-[0-9a-f-]{36}$/;

export function savedDocumentId(entries: BranchEntries): string | undefined {
  const entry = entries.findLast(
    (item) =>
      item.type === "custom" && item.customType === "canvas-note-document",
  );
  const id =
    entry?.type === "custom" ? (entry.data as { id?: unknown })?.id : undefined;
  return typeof id === "string" && DOCUMENT_ID.test(id) ? id : undefined;
}

export function formatDocumentId(date: Date, uuid: string): string {
  return `${date.toISOString().slice(0, 19).replaceAll(":", "-")}Z-${uuid}`;
}

export function sshAddressWarning(
  isSsh: boolean,
  publicHost: string | undefined,
): string | undefined {
  if (!isSsh || publicHost?.trim()) return;
  const text =
    "Canvas Note: SSH detected but CANVAS_NOTE_PUBLIC_HOST is unset. Set it to your reachable host, or use SSH port forwarding for localhost URLs.";
  return text;
}

export function statusText(url: string | undefined): string | undefined {
  return url ? `Canvas Note · ${url}` : undefined;
}

export function renderFailureMessage(error: RenderErrorReport) {
  const text = `Canvas Note 渲染失败，请检查并使用 update_blocks 修正。spec 整体替换。\n${JSON.stringify(error)}`;
  return {
    customType: "canvas-note-render-error",
    content: text,
    display: true,
  };
}

export function savedBlocksFailure(
  blockIds: readonly string[],
  documentPath: string,
  error: unknown,
): string {
  const text = `Blocks saved (${blockIds.join(", ")}) in ${documentPath}, but Canvas Note server failed: ${String(error)}. Do not insert again; fix the port/configuration and use update_blocks to retry.`;
  return text;
}

export function toolResult<T>(text: string, result: T) {
  return {
    content: [{ type: "text" as const, text }],
    details: result,
    structuredContent: result,
  };
}
