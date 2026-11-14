import { readFile } from "node:fs/promises";
import {
  MAX_FETCH_CONTENT_BYTES,
  TEMP_SPOOL_TTL_MS,
} from "../shared/limits.ts";
import {
  type FetchLike,
  request as httpRequest,
  withRequestDeadline,
} from "../shared/request.ts";
import { decodeDocument, isSupportedTextType } from "./content.ts";
import { toWebFetchError, WebFetchError } from "./errors.ts";
import { createTempSpool } from "./spool.ts";
import type { FetchRequest, FetchResponse } from "./types.ts";

const BROWSER_HEADERS = {
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "User-Agent":
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36",
} as const;

export interface FetchDocumentOptions {
  timeoutMs: number;
  fetch?: FetchLike;
  now?: () => number;
}

function contentLength(headers: Headers): number | undefined {
  const value = headers.get("content-length");
  if (!value || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

export async function fetchDocument(
  request: FetchRequest,
  options: FetchDocumentOptions,
  parentSignal?: AbortSignal,
): Promise<FetchResponse> {
  if (
    !Number.isInteger(options.timeoutMs) ||
    options.timeoutMs < 1 ||
    options.timeoutMs > 120_000
  ) {
    throw new WebFetchError(
      "invalid-config",
      "Web tools fetch configuration is invalid.",
    );
  }
  try {
    return await withRequestDeadline(
      options.timeoutMs,
      parentSignal,
      async (signal) => {
        const spool = await createTempSpool();
        try {
          // request owns the download handle; the spool owns the directory and final text.
          await spool.close();
          signal.throwIfAborted();
          const response = await httpRequest(request.url, {
            method: "GET",
            headers: BROWSER_HEADERS,
            response: "file",
            destination: spool.responsePath,
            redirect: "follow",
            maxBytes: MAX_FETCH_CONTENT_BYTES,
            signal,
            fetch: options.fetch,
            validateResponse({ headers }) {
              if (!isSupportedTextType(headers.get("content-type") ?? "")) {
                throw new WebFetchError(
                  "unsupported",
                  "The requested content is not supported.",
                  {
                    source: "native-http",
                  },
                );
              }
            },
          });
          signal.throwIfAborted();
          const body = await readFile(spool.responsePath);
          const document = await decodeDocument(
            body,
            response.headers.get("content-type") ?? "",
            new URL(response.finalUrl).pathname,
            signal,
          );
          signal.throwIfAborted();
          const bounded = await spool.saveText(document.text);
          return {
            text: bounded.text,
            title: document.title,
            contentType: document.contentType,
            contentLength: contentLength(response.headers) ?? response.bytes,
            finalUrl: response.finalUrl,
            source: "native-http",
            fullOutputPath: spool.contentPath,
            expiresAt: new Date(
              (options.now ?? Date.now)() + TEMP_SPOOL_TTL_MS,
            ).toISOString(),
            ...(document.truncated || bounded.truncated
              ? {
                  truncation: {
                    totalBytes: document.totalBytes,
                    outputBytes: bounded.outputBytes,
                  },
                }
              : {}),
          };
        } catch (error) {
          await spool.cleanup();
          throw error;
        }
      },
    );
  } catch (error) {
    throw toWebFetchError(error);
  }
}
