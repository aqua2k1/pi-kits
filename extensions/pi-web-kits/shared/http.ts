import {
  assertNotCancelled,
  errorFromStatus,
  errorMessageForCode,
  toWebSearchError,
  WebSearchError,
} from "../core/errors.ts";
import type { WebSearchProviderName } from "../core/types.ts";
import {
  MAX_RESPONSE_BYTES,
  MAX_SEARCH_TIMEOUT_MS,
  MIN_SEARCH_TIMEOUT_MS,
} from "./limits.ts";

export type FetchLike = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

export function isSafeHeaderValue(value: string, maxLength = 8_192): boolean {
  return value.length <= maxLength && /^[\x21-\x7e]+$/.test(value);
}

export function validateTimeout(timeoutMs: number): number {
  if (
    !Number.isInteger(timeoutMs) ||
    timeoutMs < MIN_SEARCH_TIMEOUT_MS ||
    timeoutMs > MAX_SEARCH_TIMEOUT_MS
  ) {
    throw new WebSearchError("invalid-config", "Search timeout is invalid.");
  }
  return timeoutMs;
}

/** One deadline covers auth, fetch and body consumption, including uncooperative I/O. */
export async function withSearchDeadline<T>(
  provider: WebSearchProviderName,
  timeoutMs: number,
  parent: AbortSignal | undefined,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  assertNotCancelled(parent);
  const controller = new AbortController();
  const fail = (code: "cancelled" | "timeout") =>
    controller.abort(
      new WebSearchError(code, errorMessageForCode(code, provider), {
        provider,
      }),
    );
  const onParentAbort = () => fail("cancelled");
  parent?.addEventListener("abort", onParentAbort, { once: true });
  const timer = setTimeout(() => fail("timeout"), timeoutMs);
  let onAbort = () => {};
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(controller.signal.reason);
    controller.signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([run(controller.signal), aborted]);
  } catch (error) {
    throw toWebSearchError(
      controller.signal.aborted ? controller.signal.reason : error,
      provider,
    );
  } finally {
    clearTimeout(timer);
    parent?.removeEventListener("abort", onParentAbort);
    controller.signal.removeEventListener("abort", onAbort);
  }
}

/** Redirects are never followed and raw status/body/transport errors never escape. */
export async function fetchJson(
  fetcher: FetchLike,
  provider: WebSearchProviderName,
  url: string | URL,
  init: RequestInit & { signal: AbortSignal },
): Promise<unknown> {
  init.signal.throwIfAborted();
  const response = await fetcher(url, { ...init, redirect: "error" });
  if (init.signal.aborted || !response.ok || response.redirected) {
    void response.body?.cancel().catch(() => {});
    init.signal.throwIfAborted();
    throw response.redirected
      ? new WebSearchError(
          "invalid-response",
          "Search redirects are not allowed.",
          { provider },
        )
      : errorFromStatus(response.status, provider);
  }
  const reader = response.body?.getReader();
  if (!reader)
    throw new WebSearchError("invalid-response", "Search response is empty.", {
      provider,
    });
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  init.signal.addEventListener("abort", cancel, { once: true });
  try {
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      init.signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        throw new WebSearchError(
          "invalid-response",
          "Search response exceeds the size limit.",
          { provider },
        );
      }
      chunks.push(value);
    }
    init.signal.throwIfAborted();
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    } catch {
      throw new WebSearchError(
        "invalid-response",
        "Search returned invalid JSON.",
        { provider },
      );
    }
  } finally {
    init.signal.removeEventListener("abort", cancel);
    cancel();
    reader.releaseLock();
  }
}
