import type { Api, Model } from "@earendil-works/pi-ai";
import { appendUnique, type ToolRule } from "./tools.ts";

const BY_API_MODEL: Readonly<Record<string, readonly ToolRule[]>> = {
  "openai-responses:deepseek-v4-pro": [
    { tool: { type: "web_search" }, match: (t) => t.type === "web_search" },
  ],
  "openai-completions:deepseek-flash": [
    {
      tool: { type: "deepseek_web_search", name: "deepseek_web_search" },
      match: (t) => t.type === "deepseek_web_search",
    },
    {
      tool: { type: "deepseek_read_url", name: "deepseek_read_url" },
      match: (t) => t.type === "deepseek_read_url",
    },
  ],
};

function deepseek(
  payload: Record<string, unknown>,
  model: Model<Api>,
): Record<string, unknown> | undefined {
  const rules = BY_API_MODEL[`${model.api}:${model.id}`] ?? [];
  const tools = appendUnique(payload.tools, rules);
  return tools && { ...payload, tools };
}

export const deepseekProviders = {
  deepseek,
};
