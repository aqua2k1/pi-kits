import { createHerdrAdapter } from "./herdr.ts";
import { createHerdrAppAdapter } from "./herdr-app.ts";
import type { MuxAdapter, MuxFactoryOptions } from "./index.ts";

/** Select the first matching mux in explicit priority order without probing CLIs. */
export function resolveMux(
  env: NodeJS.ProcessEnv = process.env,
  options?: MuxFactoryOptions,
): MuxAdapter | undefined {
  if (env.HC_TERMINAL_ID?.trim()) {
    return createHerdrAppAdapter({ ...options, env });
  }
  if (env.HERDR_ENV === "1") {
    return createHerdrAdapter({ env });
  }
  return undefined;
}
