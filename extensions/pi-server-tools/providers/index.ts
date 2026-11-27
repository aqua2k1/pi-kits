import type { Api, Model } from "@earendil-works/pi-ai";
import { googleProviders } from "./google.ts";
import { openaiProviders } from "./openai.ts";

export type ProviderInjector = (
  payload: Record<string, unknown>,
  model: Model<Api>,
) => Record<string, unknown> | undefined;

export const PROVIDERS: Readonly<Record<string, ProviderInjector>> = {
  ...openaiProviders,
  ...googleProviders,
};
