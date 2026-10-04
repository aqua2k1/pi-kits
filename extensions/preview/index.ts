/**
 * /preview - pick one of the agent's complete replies and preview it in neovim.
 *
 * Behavior:
 *   - While the agent is busy (streaming / running tools): notify and do nothing.
 *   - If there is no assistant reply yet: notify and do nothing.
 *   - Otherwise: open a selector listing every complete LLM reply on the
 *     current branch, newest on top. Each reply = all assistant messages
 *     between two role:"user" messages (a full agent run). Pick one -> open
 *     `nvim -R` on a temp .md file containing that reply's text, plus thinking
 *     blocks only when `--thinking` is passed.
 *   - Alt+P opens the latest complete reply directly, without thinking blocks.
 *
 * Only text blocks are included by default. With `--thinking`, thinking blocks
 * are also included and rendered with a `> ` quote prefix. Other block types
 * (toolCall / images) are omitted.
 *
 * Pure read-only preview: nothing is written back to the session. The temp
 * file is deleted when nvim exits. User may still `:w!` to another path; only
 * the original temp path is removed.
 *
 * Usage: /preview [--thinking]
 */

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { readPiKitsConfig } from "@pi-kits/config";
import { readonlyPreview } from "../../shared/readonly-preview.ts";

/** Max chars of the reply snippet shown in the selector. */
const SNIPPET_MAX = 50;

const USAGE = "/preview [--thinking]";

const HELP_TEXT = [
  USAGE,
  "",
  "  (无参数)    选择一条过往回复，用 nvim -R 只读预览文本内容",
  "  --thinking  同时包含 thinking blocks（以 Markdown 引用形式显示）",
  "",
  "快捷键：Alt+P 直接打开最新回复的只读预览（不包含 thinking blocks）。",
].join("\n");

/** Minimal entry shape we read from a session branch. */
type BranchEntry = {
  type?: string;
  message?: { role?: string; content?: unknown };
};

type ParsedPreviewArgs = {
  includeThinking: boolean;
  showHelp: boolean;
};

/** Truncate to maxLen chars, appending an ellipsis if cut. */
function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen)}…`;
}

function parsePreviewArgs(
  args: string | undefined,
): ParsedPreviewArgs | { error: string } {
  const raw = args?.trim() ?? "";
  if (raw === "") return { includeThinking: false, showHelp: false };

  let includeThinking = false;
  let showHelp = false;
  for (const token of raw.split(/\s+/)) {
    if (token === "--thinking") {
      includeThinking = true;
    } else if (token === "help" || token === "--help" || token === "-h") {
      showHelp = true;
    } else {
      return { error: `未知参数 "${token}"` };
    }
  }

  return { includeThinking, showHelp };
}

/** Extract text from a content block array. Returns joined markdown. */
function renderAssistantContent(
  content: unknown,
  includeThinking: boolean,
): string {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (block == null || typeof block !== "object") continue;
    const b = block as { type?: string; text?: string; thinking?: string };
    if (b.type === "text" && typeof b.text === "string") {
      if (b.text.length > 0) parts.push(b.text);
    } else if (
      includeThinking &&
      b.type === "thinking" &&
      typeof b.thinking === "string"
    ) {
      if (b.thinking.length > 0) {
        // blockquote-prefix every line
        parts.push(
          b.thinking
            .split("\n")
            .map((ln) => `> ${ln}`)
            .join("\n"),
        );
      }
    }
    // toolCall / image / other -> omitted
  }
  return parts.join("\n\n");
}

/**
 * Segment the current branch into records. Each record = the assistant
 * messages of one complete agent run, i.e. all assistant messages between two
 * role:"user" messages (or the start/end of the branch). toolResult / custom /
 * bashExecution entries between assistant messages do not split a run.
 * Returns records chronologically (oldest first).
 */
function buildRecords(getBranch: () => BranchEntry[]): BranchEntry[][] {
  const entries = getBranch(); // chronological: root -> leaf
  const records: BranchEntry[][] = [];
  let current: BranchEntry[] = [];
  for (const e of entries) {
    if (e?.type === "message" && e.message?.role === "user") {
      if (current.length > 0) {
        records.push(current);
        current = [];
      }
    } else if (e?.type === "message" && e.message?.role === "assistant") {
      current.push(e);
    }
    // toolResult / custom / bashExecution / etc. -> ignored, do not split
  }
  if (current.length > 0) records.push(current);
  return records;
}

/** First non-empty line of the first non-empty text block in the run. "" if none. */
function openingLineOfRun(record: BranchEntry[]): string {
  for (const e of record) {
    if (e?.type !== "message" || e.message?.role !== "assistant") continue;
    const content = e.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block == null || typeof block !== "object") continue;
      const b = block as { type?: string; text?: string };
      if (
        b.type === "text" &&
        typeof b.text === "string" &&
        b.text.length > 0
      ) {
        const line = b.text
          .split("\n")
          .map((l) => l.trim())
          .find((l) => l.length > 0);
        if (line) return line;
      }
    }
  }
  return "";
}

/** Render a record's body: text, plus optional thinking, joined by blank lines. */
function renderRecordBody(
  record: BranchEntry[],
  includeThinking: boolean,
): string {
  const blocks: string[] = [];
  for (const e of record) {
    const rendered = renderAssistantContent(
      e.message?.content,
      includeThinking,
    );
    if (rendered.length > 0) blocks.push(rendered);
  }
  return blocks.join("\n\n");
}

async function openPreview(
  ctx: ExtensionContext,
  options: { includeThinking: boolean; latestOnly: boolean; editor: string },
): Promise<void> {
  if (!ctx.isIdle()) {
    ctx.ui.notify("回复尚未结束，请稍后再试", "info");
    return;
  }

  if (ctx.mode !== "tui") {
    ctx.ui.notify("/preview 需要交互式终端", "error");
    return;
  }

  const records = buildRecords(() => ctx.sessionManager.getBranch());
  if (records.length === 0) {
    ctx.ui.notify("尚无可预览的回复", "info");
    return;
  }

  let record: BranchEntry[] | undefined;
  if (options.latestOnly) {
    record = records[records.length - 1];
  } else {
    // #1 = oldest ... #N = newest; list newest-first so #N is on top.
    const labels = records.map((rec, i) => {
      const snippet = openingLineOfRun(rec);
      const text = snippet ? truncate(snippet, SNIPPET_MAX) : "(无文本)";
      return `#${i + 1} · ${text}`;
    });
    const ordered = [...labels].reverse();

    const choice = await ctx.ui.select("预览哪条回复：", ordered);
    if (choice === undefined) return; // cancelled

    const idx = labels.indexOf(choice);
    if (idx === -1) return;
    record = records[idx];
  }

  if (record === undefined) return;

  const body = renderRecordBody(record, options.includeThinking);
  if (!body.trim()) {
    ctx.ui.notify("该回复无可预览内容", "info");
    return;
  }

  const result = await readonlyPreview(ctx, {
    prefix: "pi-preview-",
    extension: "md",
    editor: options.editor,
    body,
  });
  if (result.kind === "not-found") {
    ctx.ui.notify("未找到 nvim，请确认已安装并在 PATH 中", "error");
    return;
  }
  if (result.kind === "launch-error") {
    ctx.ui.notify("/preview 打开 nvim 失败", "error");
    return;
  }
}

export default function (pi: ExtensionAPI) {
  const config = readPiKitsConfig();
  if (!config.preview.enabled) return;

  pi.registerCommand("preview", {
    description:
      "Preview a past reply in neovim (read-only). Usage: /preview [--thinking]",
    handler: async (args, ctx) => {
      const parsed = parsePreviewArgs(args);
      if ("error" in parsed) {
        ctx.ui.notify(`${parsed.error}，用法：${USAGE}`, "error");
        ctx.ui.notify(HELP_TEXT, "info");
        return;
      }

      if (parsed.showHelp) {
        ctx.ui.notify(HELP_TEXT, "info");
        return;
      }

      await openPreview(ctx, {
        includeThinking: parsed.includeThinking,
        latestOnly: false,
        editor: config.terminal.editor,
      });
    },
  });

  pi.registerShortcut("alt+p", {
    description: "Open the latest reply preview in neovim (read-only)",
    handler: async (ctx) => {
      await openPreview(ctx, {
        includeThinking: false,
        latestOnly: true,
        editor: config.terminal.editor,
      });
    },
  });
}
