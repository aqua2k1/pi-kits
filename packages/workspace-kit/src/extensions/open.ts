/**
 * Open Extension
 *
 * Opens files, URLs, and directories with the system's default application.
 *
 * /open — user command
 * open  — LLM-callable tool
 */

import { existsSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readPiKitsConfig } from "@pi-kits/config";
import { Type } from "typebox";
import { doOpen, isUrl, resolveTarget } from "../lib/desktop-open.ts";

// ── Extension ──────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  const config = readPiKitsConfig().workspace;
  if (!config.enabled || !config.open.enabled) return;

  // Shared implementation
  async function openTarget(
    args: string | undefined,
    cwd: string,
  ): Promise<{ ok: boolean; message: string }> {
    if (!args?.trim()) {
      return { ok: false, message: "Usage: /open <file|url|directory>" };
    }

    const target = resolveTarget(args, cwd);

    if (!isUrl(target) && !existsSync(target)) {
      return { ok: false, message: `File not found: ${target}` };
    }

    return doOpen(target);
  }

  // ── Command ──
  pi.registerCommand("open", {
    description: "Open a file, URL, or directory with the default application",
    handler: async (args, ctx) => {
      const result = await openTarget(args, ctx.cwd);
      ctx.ui.notify(result.message, result.ok ? "info" : "warning");
    },
  });

  // ── Tool ──
  pi.registerTool({
    name: "open",
    label: "Open",
    description:
      "Open a file, URL, or directory with the system's default application. Use this to open HTML files in a browser, PDFs in a reader, directories in a file manager, etc.",
    parameters: Type.Object({
      target: Type.String({
        description: "The file path, URL, or directory to open",
      }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const result = await openTarget(params.target, ctx.cwd);
      return {
        content: [{ type: "text", text: result.message }],
        details: {},
      };
    },
  });
}
