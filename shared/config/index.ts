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
export const WEB_DEFAULTS = {
  provider: "searxng" as const,
  searchTimeoutMs: 15_000,
  maxResults: 5,
  codexModel: "gpt-6-luna",
  fetchTimeoutMs: 15_000,
  githubEnabled: true,
};

function normalizeProvider(
  provider: "searxng" | "codex-alpha-search" | "codex" | undefined,
) {
  return provider === "codex" ? "codex-alpha-search" : provider;
}

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
  const search = value["pi-web-kits"]?.search;
  if (
    search?.sources?.web !== undefined &&
    (search.routing !== undefined || search.codex !== undefined)
  ) {
    throw new Error(
      "Invalid pi-kits.json: search.sources.web cannot be mixed with legacy routing/codex.",
    );
  }
  if (
    search?.enabled !== false &&
    search?.sources?.web?.enabled === false &&
    search?.sources?.github?.enabled === false
  ) {
    throw new Error(
      "Invalid pi-kits.json: enabled search requires at least one enabled source.",
    );
  }
  const routing = search?.routing;
  const provider =
    normalizeProvider(routing?.provider) ?? WEB_DEFAULTS.provider;
  if (provider === normalizeProvider(routing?.fallbackProvider)) {
    throw new Error(
      "Invalid pi-kits.json: pi-web-kits.search.routing providers must differ.",
    );
  }
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
  const search = raw["pi-web-kits"]?.search;
  const legacy = search?.routing;
  const provider = normalizeProvider(legacy?.provider) ?? WEB_DEFAULTS.provider;
  const fallbackProvider = normalizeProvider(legacy?.fallbackProvider);
  const routing = search?.sources?.web?.routing ?? [
    provider,
    ...(legacy?.fallback
      ? [
          fallbackProvider ??
            (provider === "searxng"
              ? ("codex-alpha-search" as const)
              : ("searxng" as const)),
        ]
      : []),
  ];
  const sources = {
    web: {
      enabled: search?.sources?.web?.enabled ?? true,
      routing: [...routing],
      codex: {
        model:
          search?.sources?.web?.codex?.model ??
          search?.codex?.model ??
          WEB_DEFAULTS.codexModel,
      },
    },
    github: { enabled: search?.sources?.github?.enabled ?? true },
  };
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
    "pi-web-kits": {
      enabled: raw["pi-web-kits"]?.enabled ?? true,
      search: {
        enabled: raw["pi-web-kits"]?.search?.enabled ?? true,
        sources,
        /** @internal Derived compatibility fields. */
        routing: {
          provider: routing[0] ?? WEB_DEFAULTS.provider,
          fallback: routing.length > 1,
          fallbackProvider: routing[1] ?? fallbackProvider,
        },
        timeoutMs:
          raw["pi-web-kits"]?.search?.timeoutMs ?? WEB_DEFAULTS.searchTimeoutMs,
        maxResults:
          raw["pi-web-kits"]?.search?.maxResults ?? WEB_DEFAULTS.maxResults,
        codex: {
          model: sources.web.codex.model,
        },
      },
      fetch: {
        enabled: raw["pi-web-kits"]?.fetch?.enabled ?? true,
        timeoutMs:
          raw["pi-web-kits"]?.fetch?.timeoutMs ?? WEB_DEFAULTS.fetchTimeoutMs,
        github: {
          enabled:
            raw["pi-web-kits"]?.fetch?.github?.enabled ??
            WEB_DEFAULTS.githubEnabled,
        },
      },
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
