import { type Static, Type } from "typebox";
import { WEB_SEARCH_PROVIDER_NAMES } from "./search/types.ts";

// Shared by the response contracts and output schemas to avoid shape drift.
export const SearchResultSchema = Type.Object({
  title: Type.String(),
  url: Type.String(),
  snippet: Type.String(),
});

export const SearchDetailsSchema = Type.Object({
  query: Type.String(),
  backend: Type.Enum(WEB_SEARCH_PROVIDER_NAMES, { type: "string" }),
  resultCount: Type.Integer({ minimum: 0 }),
  results: Type.Array(SearchResultSchema),
  hasSummary: Type.Boolean(),
  truncated: Type.Optional(Type.Boolean()),
});

export type SearchDetails = Static<typeof SearchDetailsSchema>;

export const SearchOutputSchema = Type.Object({
  ...SearchDetailsSchema.properties,
  summary: Type.Optional(Type.String()),
});

export type SearchMachineOutput = Static<typeof SearchOutputSchema>;

export const FetchSourceSchema = Type.Enum(
  ["native-http", "github-gh"] as const,
  { type: "string" },
);

export const FetchTruncationSchema = Type.Object({
  totalBytes: Type.Integer({ minimum: 0 }),
  outputBytes: Type.Integer({ minimum: 0 }),
  totalLines: Type.Optional(Type.Integer({ minimum: 0 })),
  outputLines: Type.Optional(Type.Integer({ minimum: 0 })),
});

export const SavedContentSchema = Type.Object({
  path: Type.String({
    description:
      "Local saved text file. Use the read tool to inspect its contents.",
  }),
  bytes: Type.Integer({
    minimum: 0,
    description:
      "UTF-8 byte length of the saved formatted/decoded text, not the HTTP response size.",
  }),
  lines: Type.Integer({
    minimum: 1,
    description:
      "Saved file line count using read's numbering; includes an empty final line after a newline, and an empty file has one line.",
  }),
  maxLineBytes: Type.Integer({
    minimum: 0,
    description:
      "Longest saved line in UTF-8 bytes, excluding the newline. Lines over 50 KiB cannot be returned by the built-in read tool.",
  }),
  truncated: Type.Boolean({
    description: "True when content limits capped the saved text itself.",
  }),
  expiresAt: Type.Optional(Type.String()),
  truncation: Type.Optional(FetchTruncationSchema),
});

export const FetchDetailsSchema = Type.Object({
  url: Type.String({
    description:
      "Compatibility alias of finalUrl: the final redacted URL, not the requested URL.",
  }),
  finalUrl: Type.String({
    description: "Final redacted URL reported by the selected fetch handler.",
  }),
  title: Type.Optional(Type.String()),
  contentType: Type.Optional(Type.String()),
  contentLength: Type.Optional(Type.Integer({ minimum: 0 })),
  source: FetchSourceSchema,
  savedContent: SavedContentSchema,
});

export type FetchDetails = Readonly<Static<typeof FetchDetailsSchema>>;

export const FetchOutputSchema = FetchDetailsSchema;

export type FetchMachineOutput = Static<typeof FetchOutputSchema>;
