import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export function applyDocsGuidance(sections: Record<string, string>): void {
  sections.docs =
    "Use the current project's documentation and implementation as the source of truth; when an interface or convention is unclear, consult the relevant documentation before making changes.";
}

export default function hidePrompts(pi: ExtensionAPI) {
  pi.on("before_agent_start", async (event, ctx) => {
    const path = join(ctx.cwd, ".pi", "agent", "pi-hide-prompts.json");
    let hideDocs = true;
    try {
      const config = JSON.parse(await readFile(path, "utf8"));
      if (
        config === null ||
        typeof config !== "object" ||
        Array.isArray(config) ||
        (config.hideDocs !== undefined && typeof config.hideDocs !== "boolean")
      ) {
        throw new Error("hideDocs must be a boolean");
      }
      hideDocs = config.hideDocs ?? true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        ctx.ui.notify(
          `pi-hide-prompts: ${path}: ${error instanceof Error ? error.message : String(error)}`,
          "warning",
        );
        return;
      }
    }
    if (!hideDocs) return;
    applyDocsGuidance(event.systemPromptOptions.sections);
  });
}
