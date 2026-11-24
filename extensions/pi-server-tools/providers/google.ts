import type { Api, Model } from "@earendil-works/pi-ai";
import { appendUnique, isRecord, type ToolRule } from "./tools.ts";

const GOOGLE_TOOLS: readonly ToolRule[] = [
  {
    tool: { googleSearch: {} },
    match: (t) => "googleSearch" in t || "google_search" in t,
  },
  {
    tool: { urlContext: {} },
    match: (t) => "urlContext" in t || "url_context" in t,
  },
];

const APIS = new Set<Api>(["google-generative-ai", "google-vertex"]);

function google(
  payload: Record<string, unknown>,
  model: Model<Api>,
): Record<string, unknown> | undefined {
  if (!APIS.has(model.api)) return undefined;
  const config = isRecord(payload.config) ? payload.config : {};
  const tools = appendUnique(config.tools, GOOGLE_TOOLS);
  return tools && { ...payload, config: { ...config, tools } };
}

export const googleProviders = {
  google,
  "google-vertex": google,
};
