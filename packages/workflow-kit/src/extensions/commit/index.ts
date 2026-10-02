/**
 * Commit Extension
 *
 * /commit — interactive commit flow:
 *   1. Collect staged files (git diff --cached --name-status) and confirm with the user.
 *   2. Pick the generation model — searchable fuzzy picker in TUI (pi's own
 *      ui api: ctx.ui.custom + pi-tui fuzzyFilter), plain select elsewhere.
 *      The configured model leads, then the last used model
 *      (pi-kits.json workflow.commit.lastModel), then the current model.
 *      Model memory is read and updated only when rememberModel is enabled.
 *   3. Generate a Conventional Commits message with a `pi -p` child process:
 *      rules are embedded in core.ts (formerly agents/commit.md, deleted),
 *      the staged diff is piped on stdin, and the child runs tool-less.
 *   4. Confirm the generated message (submit / regenerate / cancel), then run
 *      `git commit -m` directly.
 *
 * Structure: index.ts (command wiring + flow) / ui.ts (dialogs) / core.ts
 * (pi-free git + generation logic, unit-tested).
 */

import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { readPiKitsConfig } from "@pi-kits/config";
import { notify } from "../../lib/notifications/index.ts";
import {
  buildTask,
  firstLineOf,
  getStagedDiff,
  getStagedFiles,
  gitCommit,
  readLastModel,
  runPiGenerate,
  type StagedFile,
  stripCodeFences,
  writeLastModel,
} from "./core.ts";
import { chooseAction, chooseModel } from "./ui.ts";

/** `provider/model-id` of the current session model, if any. */
function currentModelLabel(ctx: ExtensionCommandContext): string | undefined {
  const model = ctx.model;
  return model ? `${model.provider}/${model.id}` : undefined;
}

export default function (pi: ExtensionAPI) {
  const { workflow } = readPiKitsConfig();
  const config = workflow.commit;
  if (!workflow.enabled || !config.enabled) return;

  let quitAfterStartupCommit = false;

  pi.registerFlag("commit", {
    description: "Run the commit flow at startup",
    type: "boolean",
    default: false,
  });

  pi.on("session_start", (event) => {
    if (event.reason !== "startup" || pi.getFlag("commit") !== true) return;

    quitAfterStartupCommit = true;
    pi.sendUserMessage("/commit", { expandPromptTemplates: true });
  });

  pi.registerCommand("commit", {
    description: "查看已暂存文件,选模型生成 commit message,确认后提交",
    handler: async (_args, ctx) => {
      const shouldQuitAfterCommit = quitAfterStartupCommit;
      quitAfterStartupCommit = false;

      if (!ctx.hasUI) {
        ctx.ui.notify("commit 需要交互式界面", "warning");
        return;
      }

      // 1. Staged files.
      let files: StagedFile[];
      try {
        files = getStagedFiles(ctx.cwd);
      } catch (err) {
        ctx.ui.notify(`获取暂存文件失败:${firstLineOf(err)}`, "error");
        return;
      }
      if (files.length === 0) {
        ctx.ui.notify("没有已暂存的文件", "info");
        return;
      }

      // 2. Confirm the file list.
      const listText = files
        .map((file) => `  ${file.status.padEnd(4)} ${file.path}`)
        .join("\n");
      if (
        !(await ctx.ui.confirm(`提交 ${files.length} 个暂存文件?`, listText))
      ) {
        ctx.ui.notify("已取消,未提交", "info");
        return;
      }

      // 3. Configured model leads, then optional remembered model, then current.
      const lastModel = config.rememberModel ? readLastModel() : undefined;
      const first = config.model ?? lastModel ?? currentModelLabel(ctx);
      const model = await chooseModel(
        ctx,
        first,
        config.model !== undefined || lastModel !== undefined,
      );
      if (!model) {
        ctx.ui.notify("已取消,未提交", "info");
        return;
      }
      if (config.rememberModel) writeLastModel(model);

      // 4. Generate (regenerate loops), confirm, then commit.
      for (;;) {
        ctx.ui.setStatus("commit", "生成 commit message 中…");
        let message: string;
        try {
          const result = await runPiGenerate({
            model,
            thinking: config.thinking,
            timeoutMs: config.timeoutMs,
            task: buildTask(files, getStagedDiff(ctx.cwd)),
            cwd: ctx.cwd,
          });
          if (result.error) throw new Error(result.error);
          message = stripCodeFences(result.message);
          if (message.length === 0) throw new Error("生成结果为空");
        } catch (err) {
          ctx.ui.setStatus("commit", undefined);
          ctx.ui.notify(`生成失败:${firstLineOf(err)}`, "error");
          return;
        }
        ctx.ui.setStatus("commit", undefined);
        if (workflow.notify.enabled) notify("pi", "commit message done!");

        const action = await chooseAction(ctx, message);
        if (action === undefined || action === "取消") {
          ctx.ui.notify("已取消,未提交", "info");
          return;
        }
        if (action === "重新生成") continue;

        // 5. Commit directly — message already approved.
        try {
          ctx.ui.notify(`提交成功:${gitCommit(message, ctx.cwd)}`, "info");
          if (shouldQuitAfterCommit) ctx.shutdown();
        } catch (err) {
          ctx.ui.notify(`提交失败:${firstLineOf(err)}`, "error");
        }
        return;
      }
    },
  });
}
