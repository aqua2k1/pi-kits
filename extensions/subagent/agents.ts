import { type Dirent, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@pi-kits/config";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { RuntimeId } from "./runtime/index.ts";

const MAX_FILE_BYTES = 64 * 1024;

const NonEmptyString = Type.With(Type.String({ pattern: "\\S" }), {
  description: "must be a non-empty string",
});
const BooleanField = Type.With(Type.Boolean(), {
  description: "must be a boolean",
});
const RuntimeConfigSchema = Type.With(
  Type.Refine(
    Type.Record(Type.String(), Type.Unknown()),
    (value) =>
      Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null,
  ),
  { description: "must be a non-null plain object" },
);

const AgentFrontmatterSchema = Type.Object({
  description: Type.Optional(NonEmptyString),
  display_name: Type.Optional(NonEmptyString),
  runtime: Type.Optional(NonEmptyString),
  runtime_config: Type.Optional(RuntimeConfigSchema),
  model: Type.Optional(NonEmptyString),
  thinking: Type.Optional(NonEmptyString),
  enabled: Type.Optional(BooleanField),
  run_in_background: Type.Optional(BooleanField),
  keep_alive: Type.Optional(BooleanField),
});

export interface AgentDefinition {
  name: string;
  description: string;
  displayName?: string;
  runtime?: RuntimeId;
  /** Raw runtime-specific frontmatter, interpreted by the selected runtime. */
  runtimeConfig?: Record<string, unknown>;
  model?: string;
  thinking?: string;
  systemPrompt: string;
  enabled: boolean;
  runInBackground?: boolean;
  keepAlive?: boolean;
  source: "global" | "project";
  sourcePath: string;
}

/** Reference-compatible filenames and snake_case frontmatter; no built-ins. */
export function parseAgentDefinition(
  text: string,
  sourcePath: string,
  source: AgentDefinition["source"],
): AgentDefinition {
  function fail(reason: string): never {
    throw new Error(`Invalid agent ${sourcePath}: ${reason}`);
  }
  if (Buffer.byteLength(text) > MAX_FILE_BYTES) fail("file exceeds 64 KiB");
  const normalized = text.replace(/^\uFEFF/u, "").replace(/\r\n?/g, "\n");
  if (
    /^---(?:\n|$)/.test(normalized) &&
    normalized.indexOf("\n---", 3) === -1
  ) {
    fail("unterminated YAML frontmatter");
  }
  const name = basename(sourcePath, ".md");
  if (!name.trim() || /\p{Cc}/u.test(name)) fail("invalid filename");
  let parsed: ReturnType<typeof parseFrontmatter>;
  try {
    parsed = parseFrontmatter(text);
  } catch {
    fail("invalid YAML frontmatter");
  }
  const { frontmatter: fields, body } = parsed;
  if (!Value.Check(AgentFrontmatterSchema, fields)) {
    const error = Value.Errors(AgentFrontmatterSchema, fields)[0];
    const field = error?.instancePath.slice(
      1,
    ) as keyof typeof AgentFrontmatterSchema.properties;
    if (!field) fail("YAML frontmatter must be an object");
    const description = AgentFrontmatterSchema.properties[field]?.description;
    fail(`${field} ${description ?? "does not match the schema"}`);
  }
  const runtime = fields.runtime?.trim();
  return {
    name,
    ...(runtime ? { runtime } : {}),
    ...(fields.runtime_config !== undefined
      ? { runtimeConfig: fields.runtime_config }
      : {}),
    description: fields.description?.trim() ?? name,
    displayName: fields.display_name?.trim(),
    model: fields.model?.trim(),
    thinking: fields.thinking?.trim(),
    systemPrompt: body.trim(),
    enabled: fields.enabled ?? true,
    runInBackground: fields.run_in_background,
    keepAlive: fields.keep_alive,
    source,
    sourcePath,
  };
}

/** Read afresh per invocation. A project definition replaces the whole global one. */
export function loadAgentDefinitions(
  cwd: string,
  agentDir = getAgentDir(),
): Map<string, AgentDefinition> {
  const files = new Map<
    string,
    { path: string; source: AgentDefinition["source"] }
  >();
  for (const [dir, source] of [
    [join(agentDir, "agents"), "global"],
    [join(cwd, ".pi", "agent", "agents"), "project"],
  ] as const) {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw new Error(`Cannot read agent directory ${dir}`);
    }
    const seen = new Set<string>();
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (
        !entry.name.endsWith(".md") ||
        (!entry.isFile() && !entry.isSymbolicLink())
      ) {
        continue;
      }
      const key = basename(entry.name, ".md").toLowerCase();
      if (seen.has(key)) {
        throw new Error(`Duplicate agent name in ${dir}: ${entry.name}`);
      }
      seen.add(key);
      files.set(key, { path: join(dir, entry.name), source });
    }
  }
  const agents = new Map<string, AgentDefinition>();
  // Resolve precedence before reading: replaced global contents are irrelevant.
  for (const [key, { path, source }] of files) {
    let text: string;
    try {
      const info = statSync(path);
      if (!info.isFile() || info.size > MAX_FILE_BYTES) {
        throw new Error("size");
      }
      text = readFileSync(path, "utf8");
    } catch {
      throw new Error(`Cannot read agent file ${path} (limit 64 KiB)`);
    }
    agents.set(key, parseAgentDefinition(text, path, source));
  }
  return agents;
}

export function resolveAgentDefinition(
  cwd: string,
  name: string,
  agentDir = getAgentDir(),
): AgentDefinition {
  const agent = loadAgentDefinitions(cwd, agentDir).get(name.toLowerCase());
  if (!agent) {
    throw new Error(`Unknown subagent type: ${name}. Use list_subagent_types.`);
  }
  if (!agent.enabled) {
    throw new Error(`Subagent type is disabled: ${agent.name}`);
  }
  return agent;
}
