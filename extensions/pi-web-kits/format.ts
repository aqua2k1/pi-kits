import { WebSearchError } from "./core/errors.ts";
import type { RoutedSearchResponse } from "./core/types.ts";
import type { SearchDetails, SearchMachineOutput } from "./schema.ts";
import { MAX_OUTPUT_BYTES } from "./shared/limits.ts";

export type { SearchDetails } from "./schema.ts";

function markdownText(text: string): string {
  return text.replace(/([\\`*_[\]<>])/g, "\\$1");
}

/** Input is already sanitized by the provider; text and details use the same data. */
export function buildSearchOutput(response: RoutedSearchResponse): {
  content: { type: "text"; text: string }[];
  details: SearchDetails;
  structuredContent: SearchMachineOutput;
} {
  const results = response.results.map((result) => ({ ...result }));
  let truncated = Boolean(response.truncated);
  while (true) {
    const sections: string[] = [];
    if (response.summary)
      sections.push(`**Summary:**\n${markdownText(response.summary)}`);
    if (results.length) {
      sections.push(
        [
          `**Search results for "${markdownText(response.query)}":**`,
          "",
          ...results.map(
            (result, index) =>
              `${index + 1}. **${markdownText(result.title)}**\n   ${result.url}${result.snippet ? `\n   ${markdownText(result.snippet)}` : ""}`,
          ),
        ].join("\n"),
      );
    }
    if (!sections.length)
      sections.push(`No results found for "${markdownText(response.query)}".`);
    if (truncated)
      sections.push("[Output truncated; omitted provider data was not saved.]");
    const details: SearchDetails = {
      query: response.query,
      backend: response.provider,
      resultCount: results.length,
      results: results.map((result) => ({ ...result })),
      hasSummary: Boolean(response.summary),
      ...(truncated ? { truncated: true } : {}),
    };
    const output = {
      content: [{ type: "text" as const, text: sections.join("\n\n") }],
      details,
      structuredContent: {
        ...details,
        ...(response.summary ? { summary: response.summary } : {}),
      },
    };
    // Budget every serialized copy, including machine data and JSON escaping.
    if (
      Buffer.byteLength(JSON.stringify(output)) <= MAX_OUTPUT_BYTES &&
      output.content[0].text.split("\n").length <= 2_000
    )
      return output;
    if (!results.length)
      throw new WebSearchError(
        "invalid-response",
        "Search output exceeds the size limit.",
      );
    results.pop();
    truncated = true;
  }
}
