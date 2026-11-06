import type { FetchDetails, FetchMachineOutput } from "../schema.ts";
import { MAX_FETCH_OUTPUT_BYTES } from "../shared/limits.ts";
import { isSensitiveQueryName } from "../shared/results.ts";
import { WebFetchError } from "./errors.ts";
import type { FetchResponse } from "./types.ts";

export type { FetchDetails } from "../schema.ts";

function escapeHeader(value: string): string {
  return value.replace(/[\r\n]/g, " ").trim();
}

function displayUrl(value: string): string {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (isSensitiveQueryName(key)) {
        url.searchParams.set(key, "[redacted]");
      }
    }
    return url.toString();
  } catch {
    return "[invalid URL]";
  }
}

// Match read's line numbering, including an empty final line after a newline.
function textLayout(text: string): { lines: number; maxLineBytes: number } {
  let lines = 0;
  let maxLineBytes = 0;
  let start = 0;
  while (true) {
    const newline = text.indexOf("\n", start);
    const end = newline === -1 ? text.length : newline;
    lines++;
    maxLineBytes = Math.max(
      maxLineBytes,
      Buffer.byteLength(text.slice(start, end), "utf8"),
    );
    if (newline === -1) return { lines, maxLineBytes };
    start = newline + 1;
  }
}

/** Fetch saves content; both model and machine outputs expose only metadata. */
export function buildFetchOutput(response: FetchResponse): {
  content: { type: "text"; text: string }[];
  details: FetchDetails;
  structuredContent: FetchMachineOutput;
} {
  const truncation = response.truncation
    ? { ...response.truncation }
    : undefined;
  const details: FetchDetails = {
    url: displayUrl(response.finalUrl),
    finalUrl: displayUrl(response.finalUrl),
    ...(response.title ? { title: response.title } : {}),
    ...(response.contentType ? { contentType: response.contentType } : {}),
    ...(response.contentLength !== undefined
      ? { contentLength: response.contentLength }
      : {}),
    source: response.source,
    savedContent: {
      path: response.fullOutputPath,
      bytes: Buffer.byteLength(response.text, "utf8"),
      ...textLayout(response.text),
      truncated: Boolean(truncation),
      ...(response.expiresAt ? { expiresAt: response.expiresAt } : {}),
      ...(truncation ? { truncation } : {}),
    },
    ...(response.repositoryPath
      ? { repositoryPath: response.repositoryPath }
      : {}),
  };
  const lines = [
    `**Fetched:** ${details.finalUrl}`,
    ...(response.title ? [`**Title:** ${escapeHeader(response.title)}`] : []),
    ...(response.contentType
      ? [`**Content-Type:** ${escapeHeader(response.contentType)}`]
      : []),
    `**Source:** ${response.source}`,
    `**Saved content:** ${response.fullOutputPath}`,
    `**Saved bytes:** ${details.savedContent.bytes}`,
    `**Saved lines:** ${details.savedContent.lines}`,
    `**Longest line bytes:** ${details.savedContent.maxLineBytes}`,
    `**Saved content truncated:** ${details.savedContent.truncated}`,
    ...(response.expiresAt ? [`**Expires:** ${response.expiresAt}`] : []),
    ...(response.repositoryPath
      ? [`**Repository:** ${response.repositoryPath}`]
      : []),
    "",
    "Content is not returned inline. Use the `read` tool to inspect the saved file.",
    "Read returns at most 2000 lines or 50 KiB per call. For full-file analysis, start at line 1 and follow each returned offset until no content remains; a single read is not proof of full coverage. For targeted questions, search first and read relevant ranges.",
    ...(details.savedContent.maxLineBytes > 50 * 1_024
      ? [
          "Warning: a saved line exceeds read's 50 KiB limit. Line offsets cannot read that line; use UTF-8-safe byte chunking or structured processing via bash, not repeated line reads.",
        ]
      : []),
    ...(truncation
      ? [
          "",
          `[Saved content limited to ${truncation.outputBytes} of ${truncation.totalBytes} bytes.]`,
          "The saved file itself is limited. Reading to its end cannot recover omitted source content.",
        ]
      : []),
  ];
  const output = {
    content: [{ type: "text" as const, text: lines.join("\n") }],
    details,
    structuredContent: details,
  };
  if (Buffer.byteLength(JSON.stringify(output)) > MAX_FETCH_OUTPUT_BYTES)
    throw new WebFetchError(
      "invalid-response",
      "Fetch output exceeds the size limit.",
    );
  return output;
}
