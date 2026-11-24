import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { PROVIDERS } from "./providers/index.ts";
import { isRecord } from "./providers/tools.ts";

export function injectServerTools(
  payload: unknown,
  model: Model<Api> | undefined,
): Record<string, unknown> | undefined {
  if (!model || !isRecord(payload)) return undefined;
  return PROVIDERS[model.provider]?.(payload, model);
}

export default function serverTools(pi: ExtensionAPI): void {
  pi.on("before_provider_request", (event, ctx) =>
    injectServerTools(event.payload, ctx.model),
  );
}
