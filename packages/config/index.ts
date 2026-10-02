import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Value } from "typebox/value";
import { PI_KITS_SCHEMA, type PiKitsFileConfig } from "./schema.ts";

export { PI_KITS_SCHEMA, type PiKitsFileConfig } from "./schema.ts";
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

/** Match Pi's agent-directory resolution without importing its runtime. */
export function getAgentDir(): string {
  const configured = process.env.PI_CODING_AGENT_DIR;
  if (configured === "~") return homedir();
  if (configured?.startsWith("~/")) return join(homedir(), configured.slice(2));
  return configured || join(homedir(), ".pi", "agent");
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
  const routing = value.web?.search?.routing;
  const provider =
    normalizeProvider(routing?.provider) ?? WEB_DEFAULTS.provider;
  if (provider === normalizeProvider(routing?.fallbackProvider)) {
    throw new Error(
      "Invalid pi-kits.json: web.search.routing providers must differ.",
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
  return {
    workspace: {
      enabled: raw.workspace?.enabled ?? true,
      terminal: {
        enabled: raw.workspace?.terminal?.enabled ?? true,
        editor: raw.workspace?.terminal?.editor ?? "nvim",
        gitUI: raw.workspace?.terminal?.gitUI ?? "lazygit",
        fileManager: raw.workspace?.terminal?.fileManager ?? "yazi",
      },
      open: { enabled: raw.workspace?.open?.enabled ?? true },
      preview: { enabled: raw.workspace?.preview?.enabled ?? true },
      contextPreview: {
        enabled: raw.workspace?.contextPreview?.enabled ?? true,
      },
    },
    usage: {
      enabled: raw.usage?.enabled ?? true,
      providerUsage: {
        enabled: raw.usage?.providerUsage?.enabled ?? true,
        intervalMs: raw.usage?.providerUsage?.intervalMs ?? 600_000,
        timeoutMs: raw.usage?.providerUsage?.timeoutMs ?? 15_000,
      },
      stats: { enabled: raw.usage?.stats?.enabled ?? true },
    },
    workflow: {
      enabled: raw.workflow?.enabled ?? true,
      askUserQuestion: {
        enabled: raw.workflow?.askUserQuestion?.enabled ?? true,
      },
      commit: {
        enabled: raw.workflow?.commit?.enabled ?? true,
        model: raw.workflow?.commit?.model,
        lastModel: raw.workflow?.commit?.lastModel,
        thinking: raw.workflow?.commit?.thinking,
        timeoutMs: raw.workflow?.commit?.timeoutMs ?? 120_000,
        rememberModel: raw.workflow?.commit?.rememberModel ?? true,
      },
      notify: {
        enabled: raw.workflow?.notify?.enabled ?? true,
        quietPeriodMs: raw.workflow?.notify?.quietPeriodMs ?? 1_000,
      },
    },
    web: {
      enabled: raw.web?.enabled ?? true,
      search: {
        enabled: raw.web?.search?.enabled ?? true,
        routing: {
          provider:
            normalizeProvider(raw.web?.search?.routing?.provider) ??
            WEB_DEFAULTS.provider,
          fallback: raw.web?.search?.routing?.fallback ?? false,
          fallbackProvider: normalizeProvider(
            raw.web?.search?.routing?.fallbackProvider,
          ),
        },
        timeoutMs: raw.web?.search?.timeoutMs ?? WEB_DEFAULTS.searchTimeoutMs,
        maxResults: raw.web?.search?.maxResults ?? WEB_DEFAULTS.maxResults,
        codex: {
          model: raw.web?.search?.codex?.model ?? WEB_DEFAULTS.codexModel,
        },
      },
      fetch: {
        enabled: raw.web?.fetch?.enabled ?? true,
        timeoutMs: raw.web?.fetch?.timeoutMs ?? WEB_DEFAULTS.fetchTimeoutMs,
        github: {
          enabled:
            raw.web?.fetch?.github?.enabled ?? WEB_DEFAULTS.githubEnabled,
          mode: raw.web?.fetch?.github?.mode ?? WEB_DEFAULTS.githubMode,
          maxRepoSizeMB:
            raw.web?.fetch?.github?.maxRepoSizeMB ??
            WEB_DEFAULTS.githubMaxRepoSizeMB,
          cloneTimeoutSeconds:
            raw.web?.fetch?.github?.cloneTimeoutSeconds ??
            WEB_DEFAULTS.githubCloneTimeoutSeconds,
          clonePath:
            raw.web?.fetch?.github?.clonePath ?? WEB_DEFAULTS.githubClonePath,
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
