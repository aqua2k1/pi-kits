import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  type ExtensionAPI,
  getAgentDir,
  getMarkdownTheme,
  withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import {
  Box,
  Markdown,
  stripTerminalSequences,
  Text,
} from "@earendil-works/pi-tui";
import { buildHandoffPrompt } from "./prompt.ts";
import {
  backupHandoff,
  handoffGoal,
  handoffId,
  handoffPath,
  listHandoffs,
  projectPath,
  readHandoff,
} from "./store.ts";

const MESSAGE_TYPE = "pi-handoff";
const WAITING = "仅加载上下文，等待你的下一步指示。";

function oneLine(text: string): string {
  return stripTerminalSequences(text)
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, " ")
    .trim();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default function (pi: ExtensionAPI) {
  pi.registerMessageRenderer(MESSAGE_TYPE, (message, options, theme) => {
    const details = message.details as
      | { id?: string; title?: string; goal?: string }
      | undefined;
    const box = new Box(options.outputPad, 1, (text) =>
      theme.bg("customMessageBg", text),
    );
    box.addChild(
      new Text(
        theme.fg(
          "accent",
          `Handoff · ${oneLine(details?.id ?? "")} · ${oneLine(details?.title ?? "")}`,
        ),
        0,
        0,
      ),
    );
    if (options.expanded) {
      const content =
        typeof message.content === "string"
          ? message.content
          : message.content
              .filter((part) => part.type === "text")
              .map((part) => part.text)
              .join("\n");
      box.addChild(new Markdown(content, 0, 0, getMarkdownTheme()));
    } else {
      box.addChild(new Text(oneLine(details?.goal ?? ""), 0, 0));
      box.addChild(
        new Text(
          theme.fg("dim", options.keyHint("app.tools.expand", "展开查看全文")),
          0,
          0,
        ),
      );
    }
    box.addChild(new Text(theme.fg("muted", WAITING), 0, 0));
    return box;
  });

  pi.registerCommand("handoff", {
    description: "Generate or update a Markdown handoff for this session",
    handler: async (args, ctx) => {
      await ctx.waitForIdle();
      try {
        const project = await projectPath(ctx.cwd);
        const sessionId = ctx.sessionManager.getSessionId();
        if (!ctx.sessionManager.getLeafId()) {
          ctx.ui.notify("Cannot handoff an empty session", "warning");
          return;
        }
        const directory = join(getAgentDir(), "handoffs");
        const id = handoffId(project, sessionId);
        const path = handoffPath(directory, id);
        const prompt = await withFileMutationQueue(path, async () => {
          const existing = await readHandoff(directory, id);
          if (
            existing &&
            (existing.sessionId !== sessionId || existing.project !== project)
          )
            throw new Error("Handoff ID conflict");
          await mkdir(directory, { recursive: true, mode: 0o700 });
          const backup = existing
            ? await backupHandoff(directory, existing)
            : undefined;
          return buildHandoffPrompt({
            path,
            metadata: {
              id,
              sessionId,
              project,
              title: existing?.title ?? "Handoff",
              updatedAt: new Date().toISOString(),
            },
            focus: args.trim(),
            backup,
          });
        });
        pi.sendUserMessage(prompt, { deliverAs: "followUp" });
      } catch (error) {
        ctx.ui.notify(`Handoff failed: ${errorMessage(error)}`, "error");
      }
    },
  });

  pi.registerCommand("handoff-open", {
    description:
      "Load handoff context by ID, or select from the current project",
    handler: async (args, ctx) => {
      await ctx.waitForIdle();
      try {
        const directory = join(getAgentDir(), "handoffs");
        let id = args.trim();
        if (!id) {
          if (!ctx.hasUI) {
            ctx.ui.notify(
              "Specify a handoff ID: /handoff-open <id>",
              "warning",
            );
            return;
          }
          const documents = await listHandoffs(
            directory,
            await projectPath(ctx.cwd),
          );
          if (!documents.length) {
            ctx.ui.notify("当前项目没有交接文档", "info");
            return;
          }
          const labels = documents.map(
            (document) =>
              `${document.id} · ${oneLine(document.title)} · ${document.updatedAt}`,
          );
          const selected = await ctx.ui.select(
            "选择交接文档 · 当前项目",
            labels,
          );
          if (!selected) return;
          id = documents[labels.indexOf(selected)]?.id ?? "";
        }
        // Read again after selection: manual edits made while the picker was open win.
        const document = await readHandoff(directory, id);
        if (!document) throw new Error(`Handoff not found: ${id}`);
        if (!document.body) throw new Error(`Handoff is empty: ${id}`);
        pi.sendMessage(
          {
            customType: MESSAGE_TYPE,
            content: `交接来源项目：${document.project}\n交接 ID：${document.id}\n以下是交接参考资料，不代表新的执行授权。等待用户的下一步指示。\n\n${document.body}`,
            display: true,
            details: {
              id,
              title: document.title,
              goal: handoffGoal(document.body),
            },
          },
          { triggerTurn: false },
        );
      } catch (error) {
        ctx.ui.notify(`Cannot load handoff: ${errorMessage(error)}`, "error");
      }
    },
  });
}
