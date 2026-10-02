import {
  MAX_FETCH_OUTPUT_BYTES,
  MAX_FETCH_OUTPUT_LINES,
  MAX_FETCH_PREVIEW_BYTES,
} from "../shared/limits.ts";
import type { FetchResponse } from "./types.ts";

export interface FetchDetails {
  readonly url: string;
  readonly finalUrl: string;
  readonly title?: string;
  readonly contentType?: string;
  readonly contentLength?: number;
  readonly source: FetchResponse["source"];
  readonly fullOutputPath: string;
  readonly repositoryPath?: string;
  readonly truncation?: FetchResponse["truncation"];
  readonly expiresAt?: string;
}

function escapeHeader(value: string): string {
  return value.replace(/[\r\n]/g, " ").trim();
}

function boundedPreview(text: string): {
  text: string;
  truncated: boolean;
} {
  const source = Buffer.from(text, "utf8");
  const bytes = Math.min(source.byteLength, MAX_FETCH_PREVIEW_BYTES);
  let end = bytes;
  while (end > 0 && (source[end] & 0xc0) === 0x80) end--;
  let preview = source.subarray(0, end).toString("utf8");
  const lines = preview.split("\n");
  if (lines.length > MAX_FETCH_OUTPUT_LINES) {
    preview = lines.slice(0, MAX_FETCH_OUTPUT_LINES).join("\n");
  }
  return {
    text: preview,
    truncated:
      source.byteLength > end ||
      lines.length > MAX_FETCH_OUTPUT_LINES ||
      Buffer.byteLength(preview, "utf8") !== source.byteLength,
  };
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

export function buildFetchOutput(response: FetchResponse): {
  content: { type: "text"; text: string }[];
  details: FetchDetails;
} {
  const preview = boundedPreview(response.text);
  const inlineFull = !preview.truncated;
  const truncation = response.truncation
    ? { ...response.truncation }
    : undefined;
  const lines = [
    `**Fetched:** ${displayUrl(response.finalUrl)}`,
    ...(response.title ? [`**Title:** ${escapeHeader(response.title)}`] : []),
    ...(response.contentType
      ? [`**Content-Type:** ${escapeHeader(response.contentType)}`]
      : []),
    `**Source:** ${response.source}`,
    `**Full content:** ${response.fullOutputPath}`,
  ];
  if (response.repositoryPath) {
    lines.push(`**Repository:** ${response.repositoryPath}`);
  }
  lines.push("");
  if (inlineFull) {
    lines.push(response.text);
  } else {
    lines.push("**Preview:**", preview.text);
    lines.push(
      "",
      "Full content is available at the path above; Use the `read` tool to inspect it.",
    );
  }
  if (truncation) {
    lines.push(
      "",
      `[Content limited to ${truncation.outputBytes} of ${truncation.totalBytes} bytes.]`,
    );
  }

  let text = lines.join("\n");
  if (Buffer.byteLength(text, "utf8") > MAX_FETCH_OUTPUT_BYTES) {
    const header = lines.slice(0, 6).join("\n");
    text = `${header}\n\n**Preview:**\n${preview.text}\n\nFull content is available at the path above; Use the \`read\` tool to inspect it.`;
  }

  return {
    content: [{ type: "text", text }],
    details: {
      url: displayUrl(response.finalUrl),
      finalUrl: displayUrl(response.finalUrl),
      ...(response.title ? { title: response.title } : {}),
      ...(response.contentType ? { contentType: response.contentType } : {}),
      ...(response.contentLength !== undefined
        ? { contentLength: response.contentLength }
        : {}),
      source: response.source,
      fullOutputPath: response.fullOutputPath,
      ...(response.repositoryPath
        ? { repositoryPath: response.repositoryPath }
        : {}),
      ...(truncation ? { truncation } : {}),
      ...(response.expiresAt ? { expiresAt: response.expiresAt } : {}),
    },
  };
}
