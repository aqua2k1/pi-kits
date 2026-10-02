import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { runTerminalApp, type TerminalAppResult } from "./terminal-app.ts";

/** Keep temporary preview data outside the session; clean up even on launch failure. */
export async function readonlyPreview(
  ctx: ExtensionContext,
  options: { prefix: string; extension: "md" | "json"; body: string },
  launch: typeof runTerminalApp = runTerminalApp,
): Promise<TerminalAppResult> {
  if (ctx.mode !== "tui") return { kind: "unavailable" };
  const sessionId = (ctx.sessionManager.getSessionId() ?? "session").replace(
    /[^a-zA-Z0-9_-]/g,
    "_",
  );
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = mkdtempSync(join(tmpdir(), options.prefix));
  try {
    const file = join(
      dir,
      `${options.prefix}${sessionId}-${stamp}.${options.extension}`,
    );
    writeFileSync(file, `${options.body}\n`, { encoding: "utf8", mode: 0o600 });
    return await launch(ctx, "nvim", { args: ["-R", file], clearScreen: true });
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best effort: cleanup failure must not hide the launch result.
    }
  }
}
