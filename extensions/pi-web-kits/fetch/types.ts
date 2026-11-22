import type { Static } from "typebox";
import type { ghRequest } from "../shared/gh-request.ts";
import type { FetchLike } from "../shared/request.ts";
import type { FetchSourceSchema, FetchTruncationSchema } from "./schema.ts";

export type FetchSource = Static<typeof FetchSourceSchema>;

export interface FetchRequest {
  readonly url: URL;
}

export type FetchTruncation = Readonly<Static<typeof FetchTruncationSchema>>;

export interface FetchResponse {
  readonly text: string;
  readonly title?: string;
  readonly contentType?: string;
  readonly contentLength?: number;
  readonly finalUrl: string;
  readonly source: FetchSource;
  readonly fullOutputPath: string;
  readonly truncation?: FetchTruncation;
  readonly expiresAt?: string;
}

export interface FetchHandler {
  fetch(
    request: FetchRequest,
    signal?: AbortSignal,
  ): Promise<FetchResponse | null>;
}

export interface FetchRuntime {
  readonly fetch?: FetchLike;
  readonly ghRequest?: typeof ghRequest;
  readonly github?: FetchHandler;
  /** Effect capabilities supplied by the composition boundary. */
  readonly now?: () => number;
  readonly uuid?: () => string;
}
