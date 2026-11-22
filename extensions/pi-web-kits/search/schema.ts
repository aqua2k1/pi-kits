import { type Static, Type } from "typebox";
import { GITHUB_SEARCH_KINDS } from "./github/types.ts";

export const WEB_SEARCH_PROVIDER_NAMES = [
  "searxng",
  "codex-alpha-search",
] as const;

export type WebSearchProviderName = (typeof WEB_SEARCH_PROVIDER_NAMES)[number];

// Execution provenance is not an inventory of interchangeable web adapters.
export const SEARCH_BACKEND_NAMES = [
  ...WEB_SEARCH_PROVIDER_NAMES,
  "github-gh",
] as const;

export type SearchBackendName = (typeof SEARCH_BACKEND_NAMES)[number];

// Shared by the response contracts and output schemas to avoid shape drift.
export const SearchResultSchema = Type.Object({
  title: Type.String(),
  url: Type.String(),
  snippet: Type.String(),
});

export const SearchDetailsSchema = Type.Object({
  query: Type.String(),
  source: Type.Enum(["web", "github"], { type: "string" }),
  kind: Type.Optional(Type.Enum(GITHUB_SEARCH_KINDS, { type: "string" })),
  backend: Type.Enum(SEARCH_BACKEND_NAMES, { type: "string" }),
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
