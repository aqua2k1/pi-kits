import type { Api, Model } from "@earendil-works/pi-ai";
import { appendUnique, type ToolRule } from "./tools.ts";

const WEB_SEARCH: readonly ToolRule[] = [
  {
    tool: { type: "web_search" },
    match: (t) => t.type === "web_search" || t.type === "web_search_preview",
  },
];

const BY_API: Partial<Record<Api, readonly ToolRule[]>> = {
  "openai-responses": WEB_SEARCH,
  "openai-codex-responses": WEB_SEARCH,
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
