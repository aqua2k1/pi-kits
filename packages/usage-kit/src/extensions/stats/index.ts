import path from "node:path";
import {
  type ExtensionAPI,
  type ExtensionCommandContext,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import {
  findSessionFiles,
  type StatsSnapshot,
  scanSessionFiles,
} from "./core.ts";
import { openStatsHtml } from "./html.ts";

const STATUS_ID = "stats";

function defaultSessionDir(cwd: string, agentDir: string): string {
  const resolvedCwd = path.resolve(cwd);
  const safePath = `--${resolvedCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  return path.join(path.resolve(agentDir), "sessions", safePath);
}

function sessionRoot(ctx: ExtensionCommandContext): string {
  const agentDir = getAgentDir();
  const defaultRoot = path.resolve(agentDir, "sessions");
  const currentSessionDir = path.resolve(ctx.sessionManager.getSessionDir());
  const defaultProjectDir = path.resolve(defaultSessionDir(ctx.cwd, agentDir));

  // The default manager points at one cwd-specific directory. The stats view
  // should include every cwd under the shared sessions root instead.
  return currentSessionDir === defaultProjectDir
    ? defaultRoot
    : currentSessionDir;
}

async function collectStats(
  ctx: ExtensionCommandContext,
): Promise<StatsSnapshot> {
  const files = await findSessionFiles(sessionRoot(ctx));
  ctx.ui.setStatus(
    STATUS_ID,
    files.length === 0
      ? "stats: no sessions"
      : `stats: scanning 0/${files.length}`,
  );

  try {
    return await scanSessionFiles(files, (completed, total) => {
      ctx.ui.setStatus(STATUS_ID, `stats: scanning ${completed}/${total}`);
    });
  } finally {
    ctx.ui.setStatus(STATUS_ID, undefined);
  }
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("stats", {
    description: "查看按日期和模型聚合的 token 总量与费用",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("stats 需要交互式界面", "warning");
        return;
      }

      let snapshot: StatsSnapshot;
      try {
        snapshot = await collectStats(ctx);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`统计失败: ${message}`, "error");
        return;
      }

      try {
        const filePath = await openStatsHtml(snapshot);
        ctx.ui.notify(`统计快照已打开: ${filePath}`, "info");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`统计快照打开失败: ${message}`, "error");
      }
    },
  });
}
