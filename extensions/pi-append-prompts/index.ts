import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const DEFAULT_PROMPTS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "prompts",
);

export function loadAppendPrompts(
  promptsDir: string = DEFAULT_PROMPTS_DIR,
): string {
  if (!existsSync(promptsDir)) return "";
  return readdirSync(promptsDir)
    .filter((name) => name.endsWith(".md"))
    .sort()
    .map((name) => readFileSync(join(promptsDir, name), "utf8").trim())
    .filter(Boolean)
    .join("\n\n");
}

export default function appendPrompts(
  pi: ExtensionAPI,
  promptsDir: string = DEFAULT_PROMPTS_DIR,
): void {
  const appended = loadAppendPrompts(promptsDir);
  if (!appended) return;

  pi.on("before_agent_start", (event) => {
    const current = event.systemPromptOptions.appendSystemPrompt.trim();
    event.systemPromptOptions.appendSystemPrompt = current
      ? `${current}\n\n${appended}`
      : appended;
  });
}
