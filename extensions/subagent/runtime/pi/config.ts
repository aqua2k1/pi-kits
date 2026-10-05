import type {
  RuntimeCallConfig,
  RuntimeCommand,
  RuntimeOptions,
} from "../index.ts";

export type PiConfig = {
  tools?: string[];
  disallowed_tools?: string[];
  prompt_mode?: "replace" | "append";
  inherit_context?: boolean;
};

function toolNames(value: unknown, field: string): string[] {
  if (typeof value !== "string" && !Array.isArray(value)) {
    throw new Error(`Pi ${field} must be a CSV string or string array`);
  }
  const items: unknown[] =
    typeof value === "string"
      ? value.trim() === "none"
        ? []
        : value.split(",")
      : value;
  const names = items
    .map((item) => {
      if (typeof item !== "string") {
        throw new Error(`Pi ${field} must contain tool names`);
      }
      return item.trim();
    })
    .filter(Boolean);
  // CLI lists are comma-delimited; native names and availability belong to Pi.
  if (names.some((name) => /[,\p{Cc}]/u.test(name))) {
    throw new Error(`Pi ${field} contains an invalid tool name`);
  }
  return [...new Set(names)];
}

function checkRecord(config: Record<string, unknown>): void {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("Pi runtime configuration must be an object");
  }
}

/** Pi owns interpretation of its runtime-specific configuration and tasks. */
export function parsePiConfig(config: Record<string, unknown>): PiConfig {
  checkRecord(config);
  const result: PiConfig = {};
  for (const key of ["tools", "disallowed_tools"] as const) {
    if (config[key] !== undefined) result[key] = toolNames(config[key], key);
  }
  if (config.prompt_mode !== undefined) {
    const mode = config.prompt_mode;
    if (
      typeof mode !== "string" ||
      (mode.trim() !== "replace" && mode.trim() !== "append")
    ) {
      throw new Error("Pi prompt_mode must be replace or append");
    }
    result.prompt_mode = mode.trim() as "replace" | "append";
  }
  if (config.inherit_context !== undefined) {
    if (typeof config.inherit_context !== "boolean") {
      throw new Error("Pi inherit_context must be a boolean");
    }
    result.inherit_context = config.inherit_context;
  }
  return result;
}

export function piConfig(options: RuntimeOptions): PiConfig {
  return parsePiConfig(
    options.runtimeConfig ?? options.agent?.runtimeConfig ?? {},
  );
}

/** Retain only static Pi fields; agent/session values win on spawn. */
export function parsePiCallConfig(
  config: Record<string, unknown>,
  sessionConfig: Record<string, unknown>,
  phase: "spawn" | "resume",
): RuntimeCallConfig {
  checkRecord(config);
  checkRecord(sessionConfig);
  if (phase === "spawn") {
    return {
      runtimeConfig: parsePiConfig({ ...config, ...sessionConfig }),
      runtimeParams: {},
    };
  }
  const supplied = parsePiConfig(config);
  const retained = parsePiConfig(sessionConfig);
  for (const key of Object.keys(supplied) as (keyof PiConfig)[]) {
    if (JSON.stringify(supplied[key]) !== JSON.stringify(retained[key])) {
      throw new Error(`Cannot reconfigure Pi ${key} on resume`);
    }
  }
  return { runtimeConfig: retained, runtimeParams: {} };
}

export function parsePiTask(
  command: RuntimeCommand,
  options?: RuntimeOptions,
): RuntimeCommand {
  if (command.type !== "task") return command;
  if (!command.prompt.trim()) throw new Error("Task prompt must not be blank.");
  // Pi has no task-local config. Never forward foreign parameters to its worker.
  let task = command;
  if (Object.hasOwn(command, "runtimeParams")) {
    task = { ...command };
    delete task.runtimeParams;
  }
  const config = options ? piConfig(options) : {};
  if (config.tools === undefined) return task;
  return {
    ...task,
    instructions: {
      ...task.instructions,
      tools: config.tools.filter(
        (name) => !config.disallowed_tools?.includes(name),
      ),
    },
  };
}
