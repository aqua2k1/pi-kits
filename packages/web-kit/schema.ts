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
  fullOutputPath: Type.String(),
  repositoryPath: Type.Optional(Type.String()),
  truncation: Type.Optional(FetchTruncationSchema),
  expiresAt: Type.Optional(Type.String()),
});

export type FetchDetails = Readonly<Static<typeof FetchDetailsSchema>>;

export const FetchOutputSchema = Type.Object({
  ...FetchDetailsSchema.properties,
  text: Type.String({
    description: "Decoded/rendered text, bounded to the inline preview limit.",
  }),
  isPreview: Type.Boolean({
    description:
      "True when text omits saved content or the saved artifact was already limited; consult truncation and fullOutputPath.",
  }),
});

export type FetchMachineOutput = Static<typeof FetchOutputSchema>;
