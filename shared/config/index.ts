import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { getAgentDir as getPiAgentDir } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import {
  PI_KITS_SCHEMA,
  type PiKitsFileConfig,
  SUBAGENT_DEFAULT_EXTENSIONS,
} from "./schema.ts";

export {
  PI_KITS_SCHEMA,
  type PiKitsFileConfig,
  SUBAGENT_DEFAULT_EXTENSIONS,
  type WorkerExtensionSource,
} from "./schema.ts";
export const PI_KITS_CONFIG_FILE = "pi-kits.json";

/** Pi owns agent-directory syntax and defaults. */
export function getAgentDir(): string {
  return getPiAgentDir();
}

export function getPiKitsConfigPath(agentDir: string = getAgentDir()): string {
  return join(agentDir, PI_KITS_CONFIG_FILE);
}

export function parsePiKitsFile(text: string): PiKitsFileConfig {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("Invalid pi-kits.json: expected valid JSON.");
  }
  if (!Value.Check(PI_KITS_SCHEMA, value)) {
    const field = Value.Errors(PI_KITS_SCHEMA, value)[0]?.instancePath || "/";
    throw new Error(
      `Invalid pi-kits.json: ${field} does not match the configuration schema.`,
    );
  }
  const range = value["pi-canvas-note"]?.portRange;
  if (range && range[0] > range[1])
    throw new Error(
      "Invalid pi-kits.json: pi-canvas-note.portRange must be ordered [minimum, maximum].",
    );
  return value;
}

/** Missing files mean defaults. Invalid or unreadable files must never fail open. */
export function readPiKitsFile(
  agentDir: string = getAgentDir(),
): PiKitsFileConfig | undefined {
  let text: string;
  try {
    text = readFileSync(getPiKitsConfigPath(agentDir), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`Could not read ${getPiKitsConfigPath(agentDir)}.`, {
      cause: error,
    });
  }
  return parsePiKitsFile(text);
}

/** Validate first and atomically replace only the requested configuration fields. */
export function updatePiKitsConfig(
  update: (raw: PiKitsFileConfig) => PiKitsFileConfig,
  agentDir: string = getAgentDir(),
): void {
  const raw = update(readPiKitsFile(agentDir) ?? {});
  const text = `${JSON.stringify(raw, null, 2)}\n`;
  parsePiKitsFile(text);
  mkdirSync(agentDir, { recursive: true });
  const temporary = mkdtempSync(join(agentDir, ".pi-kits-"));
  try {
    const path = join(temporary, PI_KITS_CONFIG_FILE);
    writeFileSync(path, text, { encoding: "utf8", mode: 0o600 });
    renameSync(path, getPiKitsConfigPath(agentDir));
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

export function resolvePiKitsConfig(raw: PiKitsFileConfig = {}) {
  raw = parsePiKitsFile(JSON.stringify(raw));
  return {
    "pi-canvas-note": {
      enabled: raw["pi-canvas-note"]?.enabled ?? true,
      host: raw["pi-canvas-note"]?.host,
      portRange: [
        ...(raw["pi-canvas-note"]?.portRange ?? [10_000, 20_000]),
      ] as [number, number],
    },
    "pi-open": { enabled: raw["pi-open"]?.enabled ?? true },
    "pi-output-viewer": {
      enabled: raw["pi-output-viewer"]?.enabled ?? true,
      editor: raw["pi-output-viewer"]?.editor ?? "nvim",
    },
    "pi-ask": { enabled: raw["pi-ask"]?.enabled ?? true },
    "pi-subagent": {
      enabled: raw["pi-subagent"]?.enabled ?? true,
      maxConcurrent: raw["pi-subagent"]?.maxConcurrent ?? 4,
      extensionAllowlist: (
        raw["pi-subagent"]?.extensionAllowlist ?? [
          ...SUBAGENT_DEFAULT_EXTENSIONS,
        ]
      ).map((entry) =>
        typeof entry === "string"
          ? entry
          : { source: entry.source, extensions: [...entry.extensions] },
      ),
    },
  };
}

export type PiKitsConfig = ReturnType<typeof resolvePiKitsConfig>;

export function parsePiKitsConfig(text: string): PiKitsConfig {
  return resolvePiKitsConfig(parsePiKitsFile(text));
}

/** A fresh snapshot per extension factory; edits take effect on /reload. */
export function readPiKitsConfig(
  agentDir: string = getAgentDir(),
): PiKitsConfig {
  return resolvePiKitsConfig(readPiKitsFile(agentDir));
}
