import { WebSearchError } from "../../core/errors.ts";

export const CODEX_DEFAULT_MODEL = "gpt-5.4";

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
