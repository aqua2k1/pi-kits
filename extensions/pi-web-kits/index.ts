import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerWebToolsCommand } from "./commands.ts";
import { searchWeb } from "./composition.ts";
import {
  type readConfig,
  readConfigSnapshot,
  resolveConfig,
} from "./config.ts";
import { createFetchRuntime } from "./fetch/router.ts";
import { cleanupExpiredSpools } from "./fetch/spool.ts";
import { registerWebFetchTool } from "./fetch/tool.ts";
import { toWebSearchError } from "./search/errors.ts";
import { registerWebSearchTool } from "./search/tool.ts";

export {
  registerWebFetchTool,
  type WebFetchToolDependencies,
} from "./fetch/tool.ts";
export {
  registerWebSearchTool,
  type WebSearchToolDependencies,
} from "./search/tool.ts";

export interface WebToolsExtensionDependencies {
  readConfig?: typeof readConfig;
  cleanupExpiredSpools?: typeof cleanupExpiredSpools;
  env?: NodeJS.ProcessEnv;
}

export default async function webToolsExtension(
  pi: ExtensionAPI,
  dependencies: WebToolsExtensionDependencies = {},
): Promise<void> {
  try {
    // Resolve the file and environment once. Every registered capability receives
    // the same startup snapshot so commands cannot drift from the tools.
    const env = { ...(dependencies.env ?? process.env) };
    const snapshot = dependencies.readConfig
      ? {
          rawConfig: await dependencies.readConfig(),
          source: "injected" as const,
        }
      : await readConfigSnapshot();
    const { rawConfig } = snapshot;
    const resolvedConfig = resolveConfig(rawConfig, env);
    if (!resolvedConfig.enabled) return;
    const fetchRuntime = resolvedConfig.fetch.enabled
      ? createFetchRuntime()
      : undefined;
    if (fetchRuntime) {
      await (dependencies.cleanupExpiredSpools ?? cleanupExpiredSpools)(
        undefined,
        fetchRuntime.now?.(),
      );
    }
    if (resolvedConfig.search.enabled) {
      registerWebSearchTool(pi, { searchConfig: resolvedConfig.search, env });
    }
    if (fetchRuntime) {
      registerWebFetchTool(pi, {
        fetchConfig: resolvedConfig.fetch,
        fetchRuntime,
      });
    }
    registerWebToolsCommand(pi, {
      config: { ...snapshot, resolvedConfig },
      env,
      search: searchWeb,
    });
  } catch (error) {
    throw toWebSearchError(error);
  }
}
