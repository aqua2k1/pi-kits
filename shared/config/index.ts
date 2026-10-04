import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
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
  codexModel: "gpt-5.4",
  fetchTimeoutMs: 15_000,
  githubEnabled: true,
  githubMode: "auto" as const,
  githubMaxRepoSizeMB: 350,
  githubCloneTimeoutSeconds: 30,
  githubClonePath: join(tmpdir(), "pi-web-tools-github"),
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
  const routing = value["web-kits"]?.search?.routing;
  const provider =
    normalizeProvider(routing?.provider) ?? WEB_DEFAULTS.provider;
  if (provider === normalizeProvider(routing?.fallbackProvider)) {
    throw new Error(
      "Invalid pi-kits.json: web-kits.search.routing providers must differ.",
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

/** Top-level fields win; legacy group switches still gate legacy features. */
function mergeLegacyFeature<T extends { enabled?: boolean }>(
  legacy: T | undefined,
  groupEnabled: boolean | undefined,
  current: T | undefined,
): T & { enabled: boolean } {
  return {
    ...legacy,
    ...current,
    enabled:
      current?.enabled ?? (groupEnabled !== false && legacy?.enabled !== false),
  } as T & { enabled: boolean };
}

function normalizeLegacyConfig(raw: PiKitsFileConfig): PiKitsFileConfig {
  return {
    ...raw,
    terminal: mergeLegacyFeature(
      raw.workspace?.terminal,
      raw.workspace?.enabled,
      raw.terminal,
    ),
    open: mergeLegacyFeature(
      raw.workspace?.open,
      raw.workspace?.enabled,
      raw.open,
    ),
    preview: mergeLegacyFeature(
      raw.workspace?.preview,
      raw.workspace?.enabled,
      raw.preview,
    ),
    contextPreview: mergeLegacyFeature(
      raw.workspace?.contextPreview,
      raw.workspace?.enabled,
      raw.contextPreview,
    ),
    providerUsage: mergeLegacyFeature(
      raw.usage?.providerUsage,
      raw.usage?.enabled,
      raw.providerUsage,
    ),
    stats: mergeLegacyFeature(raw.usage?.stats, raw.usage?.enabled, raw.stats),
    askUserQuestion: mergeLegacyFeature(
      raw.workflow?.askUserQuestion,
      raw.workflow?.enabled,
      raw.askUserQuestion,
    ),
    subagent: mergeLegacyFeature(
      raw.workflow?.subagent,
      raw.workflow?.enabled,
      raw.subagent,
    ),
    commit: mergeLegacyFeature(
      raw.workflow?.commit,
      raw.workflow?.enabled,
      raw.commit,
    ),
    notify: mergeLegacyFeature(
      raw.workflow?.notify,
      raw.workflow?.enabled,
      raw.notify,
    ),
  };
}

export function resolvePiKitsConfig(raw: PiKitsFileConfig = {}) {
  raw = normalizeLegacyConfig(raw);
  return {
    terminal: {
      enabled: raw.terminal?.enabled ?? true,
      editor: raw.terminal?.editor ?? "nvim",
      gitUI: raw.terminal?.gitUI ?? "lazygit",
      fileManager: raw.terminal?.fileManager ?? "yazi",
    },
    open: { enabled: raw.open?.enabled ?? true },
    preview: { enabled: raw.preview?.enabled ?? true },
    contextPreview: {
      enabled: raw.contextPreview?.enabled ?? true,
    },
    providerUsage: {
      enabled: raw.providerUsage?.enabled ?? true,
      intervalMs: raw.providerUsage?.intervalMs ?? 600_000,
      timeoutMs: raw.providerUsage?.timeoutMs ?? 15_000,
    },
    stats: { enabled: raw.stats?.enabled ?? true },
    askUserQuestion: {
      enabled: raw.askUserQuestion?.enabled ?? true,
    },
    subagent: {
      enabled: raw.subagent?.enabled ?? true,
      mux: raw.subagent?.mux,
      maxConcurrent: raw.subagent?.maxConcurrent ?? 4,
      extensionAllowlist: structuredClone(
        raw.subagent?.extensionAllowlist ?? [...SUBAGENT_DEFAULT_EXTENSIONS],
      ),
    },
    commit: {
      enabled: raw.commit?.enabled ?? true,
      model: raw.commit?.model,
      lastModel: raw.commit?.lastModel,
      thinking: raw.commit?.thinking,
      timeoutMs: raw.commit?.timeoutMs ?? 120_000,
      rememberModel: raw.commit?.rememberModel ?? true,
    },
    notify: {
      enabled: raw.notify?.enabled ?? true,
      quietPeriodMs: raw.notify?.quietPeriodMs ?? 1_000,
    },
    "web-kits": {
      enabled: raw["web-kits"]?.enabled ?? true,
      search: {
        enabled: raw["web-kits"]?.search?.enabled ?? true,
        routing: {
          provider:
            normalizeProvider(raw["web-kits"]?.search?.routing?.provider) ??
            WEB_DEFAULTS.provider,
          fallback: raw["web-kits"]?.search?.routing?.fallback ?? false,
          fallbackProvider: normalizeProvider(
            raw["web-kits"]?.search?.routing?.fallbackProvider,
          ),
        },
        timeoutMs:
          raw["web-kits"]?.search?.timeoutMs ?? WEB_DEFAULTS.searchTimeoutMs,
        maxResults:
          raw["web-kits"]?.search?.maxResults ?? WEB_DEFAULTS.maxResults,
        codex: {
          model:
            raw["web-kits"]?.search?.codex?.model ?? WEB_DEFAULTS.codexModel,
        },
      },
      fetch: {
        enabled: raw["web-kits"]?.fetch?.enabled ?? true,
        timeoutMs:
          raw["web-kits"]?.fetch?.timeoutMs ?? WEB_DEFAULTS.fetchTimeoutMs,
        github: {
          enabled:
            raw["web-kits"]?.fetch?.github?.enabled ??
            WEB_DEFAULTS.githubEnabled,
          mode: raw["web-kits"]?.fetch?.github?.mode ?? WEB_DEFAULTS.githubMode,
          maxRepoSizeMB:
            raw["web-kits"]?.fetch?.github?.maxRepoSizeMB ??
            WEB_DEFAULTS.githubMaxRepoSizeMB,
          cloneTimeoutSeconds:
            raw["web-kits"]?.fetch?.github?.cloneTimeoutSeconds ??
            WEB_DEFAULTS.githubCloneTimeoutSeconds,
          clonePath:
            raw["web-kits"]?.fetch?.github?.clonePath ??
            WEB_DEFAULTS.githubClonePath,
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
