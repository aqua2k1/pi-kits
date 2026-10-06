import { StringEnum } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";
import { WEB_SEARCH_PROVIDER_NAMES } from "./core/types.ts";

// Shared by the response contracts and output schemas to avoid shape drift.
export const SearchResultSchema = Type.Object({
  title: Type.String(),
  url: Type.String(),
  snippet: Type.String(),
});

export const SearchDetailsSchema = Type.Object({
  query: Type.String(),
  backend: StringEnum(WEB_SEARCH_PROVIDER_NAMES),
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

export const FetchSourceSchema = StringEnum([
  "native-http",
  "github-gh",
  "github-clone",
] as const);

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
      "UTF-8 byte length of the saved text, not the HTTP response size.",
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
  repositoryPath: Type.Optional(Type.String()),
});

export type FetchDetails = Readonly<Static<typeof FetchDetailsSchema>>;

export const FetchOutputSchema = FetchDetailsSchema;

export type FetchMachineOutput = Static<typeof FetchOutputSchema>;
