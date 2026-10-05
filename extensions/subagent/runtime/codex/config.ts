import type { RuntimeCommand, RuntimeOptions } from "../index.ts";

export type CodexReviewTarget =
  | { type: "uncommittedChanges" }
  | { type: "baseBranch"; branch: string }
  | { type: "commit"; sha: string; title: string | null }
  | { type: "custom"; instructions: string };

export type CodexConfig = { runtime_args: string[] };
const TASK_LIMIT = 64 * 1024;

function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`Codex ${name} must be an object`);
  return value as Record<string, unknown>;
}
function text(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`Codex ${name} must be a nonempty string`);
  if (Buffer.byteLength(value) > TASK_LIMIT)
    throw new Error(`Codex ${name} exceeds 64 KiB`);
  return value;
}

/**
 * Switch-list shorthand, not CLI subcommands or shell command lines.
 * Values use --flag=value syntax. Codex CLI validates native switch names.
 */
export function parseCodexConfig(config: Record<string, unknown>): CodexConfig {
  record(config, "config");
  const raw = config.runtime_args;
  const values =
    raw === undefined ? [] : typeof raw === "string" ? raw.split(",") : raw;
  if (!Array.isArray(values))
    throw new Error("Codex runtime_args must be CSV or an array of strings");
  const args: CodexConfig["runtime_args"] = [];
  for (const value of values) {
    if (typeof value !== "string")
      throw new Error("Codex runtime_args must contain only strings");
    const arg = value.trim();
    if (!arg || /\p{Cc}/u.test(value))
      throw new Error(
        "Codex runtime_args entries must be nonempty and contain no control characters",
      );
    if (!args.includes(arg)) args.push(arg);
  }
  return { runtime_args: args };
}

/** Public call config splits retained switches from a fresh task-local target. */
export function parseCodexCallConfig(
  config: Record<string, unknown>,
  sessionConfig: Record<string, unknown>,
  phase: "spawn" | "resume",
): { runtimeConfig: CodexConfig; runtimeParams: Record<string, unknown> } {
  record(config, "call config");
  const retained = parseCodexConfig(sessionConfig);
  const supplied = Object.hasOwn(config, "runtime_args");
  const staticConfig = supplied ? { runtime_args: config.runtime_args } : {};
  let runtimeConfig: CodexConfig;
  if (phase === "spawn") {
    runtimeConfig = Object.hasOwn(sessionConfig, "runtime_args")
      ? retained
      : parseCodexConfig(staticConfig);
  } else {
    if (supplied) {
      const requested = parseCodexConfig(staticConfig);
      if (
        requested.runtime_args.length !== retained.runtime_args.length ||
        requested.runtime_args.some(
          (arg, i) => arg !== retained.runtime_args[i],
        )
      )
        throw new Error("Codex resume cannot reconfigure session runtime_args");
    }
    runtimeConfig = retained;
  }
  return {
    runtimeConfig,
    runtimeParams: Object.hasOwn(config, "review_target")
      ? { review_target: config.review_target }
      : {},
  };
}

/** Adapter-owned semantic entries are mapped via RPC, all others reach the CLI. */
export function codexNativeArgs(config: CodexConfig): string[] {
  return config.runtime_args
    .filter((arg) => arg !== "review" && arg !== "search")
    .map((arg) => (arg.startsWith("-") ? arg : `--${arg}`));
}

export function codexConfig(options: RuntimeOptions): CodexConfig {
  return parseCodexConfig(
    options.runtimeConfig ?? options.agent?.runtimeConfig ?? {},
  );
}

function reviewTarget(value: unknown): CodexReviewTarget {
  const target = record(value, "review_target");
  switch (target.type) {
    case "uncommittedChanges":
      return { type: "uncommittedChanges" };
    case "baseBranch":
      return { type: "baseBranch", branch: text(target.branch, "branch") };
    case "commit":
      if (target.title != null && typeof target.title !== "string")
        throw new Error("Codex commit title must be a string or null");
      return {
        type: "commit",
        sha: text(target.sha, "sha"),
        title: target.title ?? null,
      };
    case "custom":
      return {
        type: "custom",
        instructions: text(target.instructions, "custom instructions"),
      };
    default:
      throw new Error("Invalid Codex review_target type");
  }
}

/** Clears a consumed custom prompt so acceptance/send parsing is idempotent. */
export function parseCodexTask(
  command: RuntimeCommand,
  options: RuntimeOptions,
): RuntimeCommand {
  const config = codexConfig(options);
  if (command.type !== "task") return command;
  if (typeof command.prompt !== "string")
    throw new Error("Codex task prompt must be a string");
  const params = record(command.runtimeParams ?? {}, "runtimeParams");
  if (!config.runtime_args.includes("review")) {
    if (Object.hasOwn(params, "review_target"))
      throw new Error("Codex review_target requires runtime_args: review");
    text(command.prompt, "task prompt");
    return Object.keys(params).length
      ? { ...command, runtimeParams: {} }
      : command;
  }
  if (!Object.hasOwn(params, "review_target"))
    throw new Error("Codex review requires review_target on every task");
  let target = reviewTarget(params.review_target);
  if (command.prompt.trim()) {
    if (target.type !== "custom")
      throw new Error(
        "Codex structured review_target cannot carry a prompt; omit prompt or use custom instructions",
      );
    target = {
      ...target,
      instructions: text(
        `${target.instructions}\n\n${command.prompt}`,
        "custom instructions",
      ),
    };
  }
  if (Buffer.byteLength(JSON.stringify(target)) > TASK_LIMIT)
    throw new Error("Codex review_target exceeds 64 KiB");
  return { ...command, prompt: "", runtimeParams: { review_target: target } };
}
