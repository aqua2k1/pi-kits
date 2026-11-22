import { MAX_OUTPUT_BYTES } from "../shared/limits.ts";
import { WebSearchError } from "./errors.ts";
import type { SearchDetails, SearchMachineOutput } from "./schema.ts";
import type { SearchExecutionResponse, SearchResult } from "./types.ts";

export type { SearchDetails } from "./schema.ts";

const MAX_OUTPUT_LINES = 2_000;

function markdownText(text: string): string {
  return text.replace(/([\\`*_[\]<>])/g, "\\$1");
}

function formatResultItem(result: SearchResult, index: number): string {
  const snippet = result.snippet ? `\n   ${markdownText(result.snippet)}` : "";
  return `${index + 1}. **${markdownText(result.title)}**\n   ${result.url}${snippet}`;
}

function formatSearchText(
  response: SearchExecutionResponse,
  results: readonly SearchResult[],
  truncated: boolean,
): string {
  const sections: string[] = [];
  if (response.summary) {
    sections.push(`**Summary:**\n${markdownText(response.summary)}`);
  }
  if (results.length) {
    sections.push(
      [
        `**Search results for "${markdownText(response.query)}":**`,
        "",
        ...results.map(formatResultItem),
      ].join("\n"),
    );
  }
  if (!sections.length) {
    sections.push(`No results found for "${markdownText(response.query)}".`);
  }
  if (truncated) {
    sections.push("[Output truncated; omitted provider data was not saved.]");
  }
  return sections.join("\n\n");
}

function createSearchOutput(
  response: SearchExecutionResponse,
  results: readonly SearchResult[],
  truncated: boolean,
) {
  const details: SearchDetails = {
    query: response.query,
    source: response.source ?? "web",
    ...(response.kind ? { kind: response.kind } : {}),
    backend: response.provider,
    resultCount: results.length,
    results: results.map((result) => ({ ...result })),
    hasSummary: Boolean(response.summary),
    ...(truncated ? { truncated: true } : {}),
  };
  return {
    content: [
      {
        type: "text" as const,
        text: formatSearchText(response, results, truncated),
      },
    ],
    details,
    structuredContent: {
      ...details,
      ...(response.summary ? { summary: response.summary } : {}),
    },
  };
}

function fitsOutputBudget(
  output: ReturnType<typeof createSearchOutput>,
): boolean {
  // Budget every serialized copy, including machine data and JSON escaping.
  return (
    Buffer.byteLength(JSON.stringify(output)) <= MAX_OUTPUT_BYTES &&
    output.content[0].text.split("\n").length <= MAX_OUTPUT_LINES
  );
}

/** Input is already sanitized by the provider; text and details use the same data. */
export function buildSearchOutput(response: SearchExecutionResponse): {
  content: { type: "text"; text: string }[];
  details: SearchDetails;
  structuredContent: SearchMachineOutput;
} {
  for (let count = response.results.length; count >= 0; count--) {
    const truncated =
      Boolean(response.truncated) || count < response.results.length;
    const output = createSearchOutput(
      response,
      response.results.slice(0, count),
      truncated,
    );
    if (fitsOutputBudget(output)) return output;
  }
  throw new WebSearchError(
    "invalid-response",
    "Search output exceeds the size limit.",
  );
}
