import type { FetchDetails, FetchMachineOutput } from "../schema.ts";
import { MAX_FETCH_OUTPUT_BYTES } from "../shared/limits.ts";
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
      if (
        /(?:token|key|secret|password|credential|authorization|signature|^sig$)/i.test(
          key,
        )
      ) {
        url.searchParams.set(key, "[redacted]");
      }
    }
    return url.toString();
  } catch {
    return "[invalid URL]";
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
    `**Saved content truncated:** ${details.savedContent.truncated}`,
    ...(response.expiresAt ? [`**Expires:** ${response.expiresAt}`] : []),
    ...(response.repositoryPath
      ? [`**Repository:** ${response.repositoryPath}`]
      : []),
    "",
    "Content is not returned inline. Use the `read` tool to inspect the saved file.",
    ...(truncation
      ? [
          "",
          `[Saved content limited to ${truncation.outputBytes} of ${truncation.totalBytes} bytes.]`,
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
