import { createHerdrCoreExecutor } from "./herdr-core.ts";
import type { Executor, ExecutorFactoryOptions } from "./index.ts";
import { createSubprocessExecutor } from "./subprocess.ts";

/**
 * Select the first matching executor in explicit priority order:
 * 1. herdr-core (HC_TERMINAL_ID)
 * 2. subprocess (universal headless fallback)
 */
export function resolveExecutor(
  env: NodeJS.ProcessEnv = process.env,
  options?: ExecutorFactoryOptions,
): Executor {
  if (env.HC_TERMINAL_ID?.trim()) {
    return createHerdrCoreExecutor({ ...options, env });
  }
  return createSubprocessExecutor({ env });
}
