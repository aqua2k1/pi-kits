/**
 * /context-preview — open neovim to preview the most recent provider request payload.
 *
 * Behavior:
 *   - /context-preview         — open nvim -R on a temp .json file with cached payload (or empty)
 *   - /context-preview start   — start caching payloads from before_provider_request
 *   - /context-preview stop    — stop caching (keeps last cached payload viewable)
 *   - /context-preview status  — show enabled/disabled state
 *   - /context-preview help    — show usage and subcommand meanings
 *
 * The payload is the raw HTTP request body object from before_provider_request.
 * Pure read-only preview: nothing is written back to the session. The temp file
 * is deleted when nvim exits.
 *
 * Usage: /context-preview [start|stop|status|help]  (no subcommand = preview)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readPiKitsConfig } from "@pi-kits/config";
import { readonlyPreview } from "../lib/readonly-preview.ts";

const HELP_TEXT = [
  "/context-preview [start|stop|status|help]",
  "",
  "  (无参数)  用 nvim -R 只读查看最近一次 provider 请求 payload；",
  "            未启用缓存或尚无请求时内容为空",
  "  start     开始缓存 before_provider_request 的 payload（默认关闭）",
  "  stop      停止缓存；已缓存内容保留，仍可打开查看",
  "  status    显示当前缓存启用/禁用状态",
  "  help      显示本帮助",
  "",
  "payload 即发送给模型 API 的原始 HTTP 请求体：model、messages、tools、",
  "temperature 等。纯只读预览，不写入会话；临时文件在 nvim 退出后删除。",
].join("\n");

export default function (pi: ExtensionAPI) {
  const config = readPiKitsConfig().workspace;
  if (!config.enabled || !config.contextPreview.enabled) return;

  let enabled = false;
  let lastPayload: unknown = null;

  pi.on("session_start", async (_event, _ctx) => {
    enabled = false;
    lastPayload = null;
  });

  pi.on("before_provider_request", (event, _ctx) => {
    if (enabled) {
      lastPayload = event.payload;
    }
  });

  pi.registerCommand("context-preview", {
    description:
      "Preview the provider request payload in neovim (read-only). Subcommands: start | stop | status | help",
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/context-preview 需要交互式终端", "error");
        return;
      }

      const sub = args?.trim() ?? "";

      if (sub === "start") {
        enabled = true;
        ctx.ui.notify("context-preview 已启用", "info");
        return;
      }

      if (sub === "stop") {
        enabled = false;
        ctx.ui.notify("context-preview 已禁用（已缓存内容保留）", "info");
        return;
      }

      if (sub === "status") {
        ctx.ui.notify(
          `context-preview: ${enabled ? "已启用" : "已禁用"}`,
          "info",
        );
        return;
      }

      if (sub === "help") {
        ctx.ui.notify(HELP_TEXT, "info");
        return;
      }

      if (sub !== "") {
        // Unknown subcommand — show help instead of silently opening nvim.
        ctx.ui.notify(`未知参数 "${sub}"，请参考以下用法：`, "error");
        ctx.ui.notify(HELP_TEXT, "info");
        return;
      }

      // No subcommand — open nvim with cached payload (or empty content)
      const body =
        lastPayload != null ? JSON.stringify(lastPayload, null, 2) : "";

      const result = await readonlyPreview(ctx, {
        prefix: "pi-context-preview-",
        extension: "json",
        editor: config.terminal.editor,
        body,
      });
      if (result.kind === "not-found") {
        ctx.ui.notify("未找到 nvim，请确认已安装并在 PATH 中", "error");
        return;
      }
      if (result.kind === "launch-error") {
        ctx.ui.notify("/context-preview 打开 nvim 失败", "error");
        return;
      }
    },
  });
}
