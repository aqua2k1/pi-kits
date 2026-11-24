import type { Api, Model } from "@earendil-works/pi-ai";
import { appendUnique, type ToolRule } from "./tools.ts";

const SERVER_TOOLS: readonly ToolRule[] = [
  {
    tool: { type: "web_search" },
    match: (t) => t.type === "web_search" || t.type === "web_search_preview",
  },
  {
    tool: { type: "image_generation" },
    match: (t) => t.type === "image_generation",
  },
];

const BY_API: Partial<Record<Api, readonly ToolRule[]>> = {
  "openai-responses": SERVER_TOOLS,
  "openai-codex-responses": SERVER_TOOLS,
};

function openai(
  payload: Record<string, unknown>,
  model: Model<Api>,
): Record<string, unknown> | undefined {
  const tools = appendUnique(payload.tools, BY_API[model.api] ?? []);
  return tools && { ...payload, tools };
}

export const openaiProviders = {
  openai,
  "openai-codex": openai,
};
