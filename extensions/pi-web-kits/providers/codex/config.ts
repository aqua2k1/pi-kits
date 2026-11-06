import { WEB_DEFAULTS } from "@pi-kits/config";
import { WebSearchError } from "../../core/errors.ts";

export const CODEX_DEFAULT_MODEL = WEB_DEFAULTS.codexModel;

export function normalizeCodexModel(raw = CODEX_DEFAULT_MODEL): string {
  const model = raw.trim();
  if (!model || model.length > 128 || !/^[a-zA-Z0-9._-]+$/.test(model)) {
    throw new WebSearchError(
      "invalid-config",
      "Codex search model is invalid.",
      { provider: "codex-alpha-search" },
    );
  }
  return model;
}
