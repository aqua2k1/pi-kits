import { type Dirent, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@pi-kits/config";
import type { RuntimeId } from "./runtime/index.ts";

const MAX_FILE_BYTES = 64 * 1024;

export interface AgentDefinition {
  name: string;
  description: string;
  displayName?: string;
  runtime?: RuntimeId;
  /** Raw runtime-specific frontmatter, interpreted by the selected runtime. */
  runtimeConfig?: Record<string, unknown>;
  model?: string;
  thinking?: string;
  tools?: string[];
  disallowedTools?: string[];
  systemPrompt: string;
  promptMode?: "replace" | "append";
  inheritContext?: boolean;
  enabled: boolean;
  runInBackground?: boolean;
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
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) {
    fail("YAML frontmatter must be an object");
  }
  const string = (field: string): string | undefined => {
    const value = fields[field];
    if (value === undefined) return undefined;
    if (typeof value !== "string" || !value.trim()) {
      fail(`${field} must be a non-empty string`);
    }
    return value.trim();
  };
  const boolean = (field: string): boolean | undefined => {
    const value = fields[field];
    if (value === undefined) return undefined;
    if (typeof value !== "boolean") fail(`${field} must be a boolean`);
    return value;
  };
  const tools = (field: string): string[] | undefined => {
    const value = fields[field];
    if (value === undefined) return undefined;
    if (typeof value !== "string" && !Array.isArray(value)) {
      fail(`${field} must be a CSV string or string array`);
    }
    const items: unknown[] =
      typeof value === "string"
        ? value.trim() === "none"
          ? []
          : value.split(",")
        : value;
    const names = items
      .map((item) => {
        if (typeof item !== "string") fail(`${field} must contain tool names`);
        return item.trim();
      })
      .filter(Boolean);
    // CLI lists are comma-delimited; leave naming rules and availability to Pi.
    if (names.some((tool) => /[,\p{Cc}]/u.test(tool))) {
      fail(`${field} contains an invalid tool name`);
    }
    return [...new Set(names)];
  };
  const runtime = string("runtime");
  const promptMode = string("prompt_mode");
  if (
    promptMode !== undefined &&
    promptMode !== "replace" &&
    promptMode !== "append"
  ) {
    fail("prompt_mode must be replace or append");
  }
  return {
    name,
    ...(runtime ? { runtime } : {}),
    ...(fields.runtime_args !== undefined
      ? { runtimeConfig: { runtime_args: fields.runtime_args } }
      : {}),
    description: string("description") ?? name,
    displayName: string("display_name"),
    model: string("model"),
    thinking: string("thinking"),
    tools: tools("tools"),
    disallowedTools: tools("disallowed_tools"),
    systemPrompt: body.trim(),
    promptMode,
    inheritContext: boolean("inherit_context"),
    enabled: boolean("enabled") ?? true,
    runInBackground: boolean("run_in_background"),
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
