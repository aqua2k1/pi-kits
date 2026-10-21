import { Type } from "typebox";
import { Value } from "typebox/value";
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

const objectSchema = Type.Object({});
const toolListSchema = Type.Union([Type.String(), Type.Array(Type.String())]);
const configSchema = Type.Object({
  tools: Type.Optional(toolListSchema),
  disallowed_tools: Type.Optional(toolListSchema),
  prompt_mode: Type.Optional(
    Type.Union([Type.Literal("replace"), Type.Literal("append")]),
  ),
  inherit_context: Type.Optional(Type.Boolean()),
});

function toolNames(value: string | string[], field: string): string[] {
  const items =
    typeof value === "string"
      ? value.trim() === "none"
        ? []
        : value.split(",")
      : value;
  const names = items.map((item) => item.trim()).filter(Boolean);
  // CLI lists are comma-delimited; native names and availability belong to Pi.
  if (names.some((name) => /[,\p{Cc}]/u.test(name))) {
    throw new Error(`Pi ${field} contains an invalid tool name`);
  }
  return [...new Set(names)];
}

function checkRecord(config: Record<string, unknown>): void {
  if (!Value.Check(objectSchema, config)) {
    throw new Error("Pi runtime configuration must be an object");
  }
}

/** Pi owns interpretation of its runtime-specific configuration and tasks. */
export function parsePiConfig(config: Record<string, unknown>): PiConfig {
  checkRecord(config);
  const normalized: Record<string, unknown> = {
    ...config,
    // Trim before enum validation, without mutating the caller's configuration.
    prompt_mode:
      typeof config.prompt_mode === "string"
        ? config.prompt_mode.trim()
        : config.prompt_mode,
  };
  if (!Value.Check(configSchema, normalized)) {
    const field = Value.Errors(configSchema, normalized)[0]?.instancePath.split(
      "/",
    )[1];
    if (field === "prompt_mode")
      throw new Error("Pi prompt_mode must be replace or append");
    if (field === "inherit_context")
      throw new Error("Pi inherit_context must be a boolean");
    throw new Error(
      Array.isArray(normalized[field ?? ""])
        ? `Pi ${field} must contain tool names`
        : `Pi ${field} must be a CSV string or string array`,
    );
  }
  const result: PiConfig = {};
  for (const key of ["tools", "disallowed_tools"] as const) {
    if (normalized[key] !== undefined)
      result[key] = toolNames(normalized[key], key);
  }
  if (normalized.prompt_mode !== undefined)
    result.prompt_mode = normalized.prompt_mode;
  if (normalized.inherit_context !== undefined)
    result.inherit_context = normalized.inherit_context;
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
