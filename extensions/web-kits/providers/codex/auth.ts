import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { assertNotCancelled, WebSearchError } from "../../core/errors.ts";
import { isSafeHeaderValue } from "../../shared/http.ts";
import { isRecord } from "../../shared/results.ts";

const CODEX_PROVIDER_NAME = "openai-codex";
const CODEX_ACCOUNT_CLAIM = "https://api.openai.com/auth";

export interface CodexRequestAuth {
  /** Resolved for this request only. Never persist or display. */
  accessToken: string;
  accountId: string;
}

export type CodexModelRegistry = Pick<ModelRegistry, "getProviderAuth">;

/** Decode only to select the account header; the remote service verifies the JWT. */
export function extractCodexAccountId(token: string): string | undefined {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[1]) return undefined;
  try {
    const payload: unknown = JSON.parse(
      Buffer.from(parts[1], "base64url").toString("utf8"),
    );
    if (!isRecord(payload)) return undefined;
    const claims = payload[CODEX_ACCOUNT_CLAIM];
    const nested = isRecord(claims) ? claims.chatgpt_account_id : undefined;
    const accountId =
      typeof nested === "string" ? nested : payload.chatgpt_account_id;
    return typeof accountId === "string" && isSafeHeaderValue(accountId, 256)
      ? accountId
      : undefined;
  } catch {
    return undefined;
  }
}

/** Pi owns storage/refresh. No model lookup, auth.json access or provider URL overrides. */
export async function resolveCodexAuth(
  registry?: CodexModelRegistry,
  signal?: AbortSignal,
): Promise<CodexRequestAuth> {
  assertNotCancelled(signal);
  try {
    const resolved = await registry?.getProviderAuth(CODEX_PROVIDER_NAME);
    assertNotCancelled(signal);
    const accessToken = resolved?.auth.apiKey;
    // Pi's OAuth resolver stamps this source; API-key/config overrides must not qualify.
    if (
      resolved?.source !== "OAuth" ||
      !accessToken ||
      !isSafeHeaderValue(accessToken)
    )
      throw new Error();
    const accountId = extractCodexAccountId(accessToken);
    if (!accountId) throw new Error();
    return { accessToken, accountId };
  } catch (error) {
    if (error instanceof WebSearchError && error.code === "cancelled") {
      throw error;
    }
    throw new WebSearchError(
      "auth",
      "OpenAI Codex OAuth is unavailable. Run /login openai-codex.",
      { provider: "codex-alpha-search" },
    );
  }
}

export function buildCodexHeaders(auth: CodexRequestAuth): Headers {
  if (
    !isSafeHeaderValue(auth.accessToken) ||
    !isSafeHeaderValue(auth.accountId, 256)
  ) {
    throw new WebSearchError(
      "auth",
      "OpenAI Codex OAuth contains invalid request credentials.",
      { provider: "codex-alpha-search" },
    );
  }
  return new Headers({
    Accept: "application/json",
    "Content-Type": "application/json",
    Authorization: `Bearer ${auth.accessToken}`,
    "chatgpt-account-id": auth.accountId,
    originator: "pi",
  });
}
