import type { RuntimeCommand } from "../index.ts";

/** Pi owns interpretation of its runtime-specific configuration and tasks. */
export function parsePiConfig(
  config: Record<string, unknown>,
): Record<string, unknown> {
  if (config.runtime_args !== undefined) {
    throw new Error("runtime_args is not supported by the Pi runtime");
  }
  const unsupported = Object.keys(config)[0];
  if (unsupported !== undefined) {
    throw new Error(
      `Unsupported Pi runtime configuration field: ${unsupported}`,
    );
  }
  return {};
}

export function parsePiTask(command: RuntimeCommand): RuntimeCommand {
  if (command.type === "task") {
    if (Object.keys(command.runtimeParams ?? {}).length) {
      throw new Error(
        "Runtime task parameters are not supported by the Pi runtime",
      );
    }
    if (!command.prompt.trim())
      throw new Error("Task prompt must not be blank.");
  }
  return command;
}
