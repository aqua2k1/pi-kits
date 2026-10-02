/**
 * Terminal Extension
 *
 * Suspends the pi TUI to run a terminal app (nvim, lazygit, yazi), then
 * restores it when the app exits.
 *
 * Commands:
 *   /vim [file] - open nvim (optionally with a file path)
 *   /lg         - open lazygit in the current directory
 *   /fm         - open yazi in the current directory
 */

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { runTerminalApp } from "../lib/terminal-app.ts";

async function runSuspended(
  ctx: ExtensionContext,
  command: string,
  args: readonly string[] = [],
): Promise<void> {
  const result = await runTerminalApp(ctx, command, { args });

  switch (result.kind) {
    case "unavailable":
      ctx.ui.notify(`${command} requires an interactive terminal`, "warning");
      break;
    case "not-found":
      ctx.ui.notify(
        `${command} not found - please install it and ensure it's on PATH`,
        "error",
      );
      break;
    case "launch-error":
      ctx.ui.notify(
        `Failed to launch ${command}: ${result.error.message}`,
        "error",
      );
      break;
    case "exited":
      if (result.status === 0) {
        ctx.ui.notify(`${command} exited successfully`, "info");
      } else if (result.signal) {
        ctx.ui.notify(
          `${command} exited due to signal ${result.signal}`,
          "warning",
        );
      } else {
        ctx.ui.notify(
          `${command} exited with code ${result.status ?? "unknown"}`,
          "warning",
        );
      }
      break;
  }
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("vim", {
    description: "Open nvim (optionally with a file path)",
    handler: async (args, ctx) => {
      // Strip leading @ (leftover from file completion trigger) and trim
      const file = args?.trim().replace(/^@+/, "") || "";
      await runSuspended(ctx, "nvim", file ? [file] : []);
    },
  });

  pi.registerCommand("lg", {
    description: "Open lazygit in the current directory",
    handler: async (_args, ctx) => {
      await runSuspended(ctx, "lazygit");
    },
  });

  pi.registerCommand("fm", {
    description: "Open yazi in the current directory",
    handler: async (_args, ctx) => {
      await runSuspended(ctx, "yazi");
    },
  });
}
