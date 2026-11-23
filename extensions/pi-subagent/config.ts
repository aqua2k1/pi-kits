import { type Dirent, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  DefaultPackageManager,
  parseFrontmatter,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { getAgentDir, type WorkerExtensionSource } from "@pi-kits/config";
import { Type } from "typebox";
import { Value } from "typebox/value";

const MAX_FILE_BYTES = 64 * 1024;

const NonEmptyString = Type.With(Type.String({ pattern: "\\S" }), {
  description: "must be a non-empty string",
});
const BooleanField = Type.With(Type.Boolean(), {
  description: "must be a boolean",
});
const ToolListField = Type.With(
  Type.Union([Type.String(), Type.Array(Type.String())]),
  { description: "must be a CSV string or string array" },
);
const PromptModeField = Type.With(
  Type.Union([Type.Literal("replace"), Type.Literal("append")]),
  { description: "must be replace or append" },
);
const ExtensionSourceString = Type.String({
  minLength: 1,
  pattern: "^(?=.*\\S)[^\\x00-\\x1f\\x7f]+$",
});
const ExtensionsField = Type.With(
  Type.Array(
    Type.Union([
      ExtensionSourceString,
      Type.Object(
        {
          source: ExtensionSourceString,
          extensions: Type.Array(ExtensionSourceString, { uniqueItems: true }),
        },
        { additionalProperties: true },
      ),
    ]),
    { uniqueItems: true },
  ),
  { description: "must be a valid extension source list" },
);

const AgentFrontmatterSchema = Type.Object({
  description: Type.Optional(NonEmptyString),
  display_name: Type.Optional(NonEmptyString),
  model: Type.Optional(NonEmptyString),
  thinking: Type.Optional(NonEmptyString),
  enabled: Type.Optional(BooleanField),
  run_in_background: Type.Optional(BooleanField),
  prompt_mode: Type.Optional(PromptModeField),
  inherit_context: Type.Optional(BooleanField),
  tools: Type.Optional(ToolListField),
  disallowed_tools: Type.Optional(ToolListField),
  extensions: Type.Optional(ExtensionsField),
});

export interface AgentDefinition {
  name: string;
  description: string;
  displayName?: string;
  model?: string;
  thinking?: string;
  systemPrompt: string;
  enabled: boolean;
  runInBackground?: boolean;
  promptMode?: "replace" | "append";
  inheritContext?: boolean;
  tools?: string[];
  disallowedTools?: string[];
  extensions?: WorkerExtensionSource[];
  source: "global" | "project";
  sourcePath: string;
}

function parseToolNames(
  value: string | string[],
  field: string,
  fail: (reason: string) => never,
): string[] {
  const items =
    typeof value === "string"
      ? value.trim() === "none"
        ? []
        : value.split(",")
      : value;
  const names = items.map((item) => item.trim()).filter(Boolean);
  if (names.some((name) => /[,\p{Cc}]/u.test(name))) {
    fail(`${field} contains an invalid tool name`);
  }
  return [...new Set(names)];
}

/** Markdown agent definitions with flattened frontmatter settings. */
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
  const { frontmatter: rawFields, body } = parsed;
  if (!rawFields || typeof rawFields !== "object" || Array.isArray(rawFields)) {
    fail("YAML frontmatter must be an object");
  }
  const fields: Record<string, unknown> = {
    ...rawFields,
    ...(typeof rawFields.prompt_mode === "string"
      ? { prompt_mode: rawFields.prompt_mode.trim() }
      : {}),
  };
  if (!Value.Check(AgentFrontmatterSchema, fields)) {
    const error = Value.Errors(AgentFrontmatterSchema, fields)[0];
    const field = error?.instancePath.split("/")[1] as
      | keyof typeof AgentFrontmatterSchema.properties
      | undefined;
    if (!field) fail("YAML frontmatter must be an object");
    if (
      (field === "tools" || field === "disallowed_tools") &&
      Array.isArray(fields[field])
    ) {
      fail(`${field} must contain tool names`);
    }
    const description = AgentFrontmatterSchema.properties[field]?.description;
    fail(`${field} ${description ?? "does not match the schema"}`);
  }
  const systemPrompt = body.trim();
  const promptMode = fields.prompt_mode;
  if ((promptMode ?? "replace") === "replace" && !systemPrompt) {
    fail("replace prompt_mode requires a non-empty agent body");
  }
  const tools =
    fields.tools !== undefined
      ? parseToolNames(fields.tools, "tools", fail)
      : undefined;
  const disallowedTools =
    fields.disallowed_tools !== undefined
      ? parseToolNames(fields.disallowed_tools, "disallowed_tools", fail)
      : undefined;
  const extensions =
    fields.extensions !== undefined
      ? fields.extensions.map((entry) =>
          typeof entry === "string"
            ? entry.trim()
            : {
                source: entry.source.trim(),
                extensions: entry.extensions.map((ext) => ext.trim()),
              },
        )
      : undefined;
  return {
    name,
    description: fields.description?.trim() ?? name,
    displayName: fields.display_name?.trim(),
    model: fields.model?.trim(),
    thinking: fields.thinking?.trim(),
    systemPrompt,
    enabled: fields.enabled ?? true,
    runInBackground: fields.run_in_background,
    ...(promptMode !== undefined ? { promptMode } : {}),
    ...(fields.inherit_context !== undefined
      ? { inheritContext: fields.inherit_context }
      : {}),
    ...(tools !== undefined ? { tools } : {}),
    ...(disallowedTools !== undefined ? { disallowedTools } : {}),
    ...(extensions !== undefined ? { extensions } : {}),
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
      if (!info.isFile()) {
        throw new Error(`Agent path is not a regular file: ${path}`);
      }
      if (info.size > MAX_FILE_BYTES) {
        throw new Error(`Agent file exceeds 64 KiB: ${path}`);
      }
      text = readFileSync(path, "utf8");
    } catch (cause) {
      if (
        cause instanceof Error &&
        (cause.message.includes("exceeds 64 KiB") ||
          cause.message.includes("not a regular file"))
      ) {
        throw cause;
      }
      const detail = cause instanceof Error ? cause.message : String(cause);
      throw new Error(`Cannot read agent file ${path}: ${detail}`, { cause });
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
  const definitions = loadAgentDefinitions(cwd, agentDir);
  const agent = definitions.get(name.toLowerCase());
  if (!agent) {
    const available = [...definitions.values()]
      .filter((entry) => entry.enabled)
      .map((entry) => entry.name);
    const suffix = available.length
      ? ` Available agents: ${available.join(", ")}.`
      : " No configured agents found.";
    throw new Error(`Unknown subagent type: ${name}.${suffix}`);
  }
  if (!agent.enabled) {
    throw new Error(`Subagent type is disabled: ${agent.name}`);
  }
  return agent;
}

export const BASE_AGENT_PARAMETER_DESCRIPTION =
  "Agent profile name; omit for a default session.";

/** Summarize enabled agents for dynamic tool descriptions via prepareLoadout. */
export function formatAvailableAgents(
  cwd: string,
  agentDir = getAgentDir(),
): string {
  try {
    const enabled = [...loadAgentDefinitions(cwd, agentDir).values()].filter(
      (agent) => agent.enabled,
    );
    if (!enabled.length) return "";
    return ` Configured agents: ${enabled.map((agent) => `${agent.name} (${agent.description})`).join(", ")}.`;
  } catch {
    return "";
  }
}

export function formatAgentParameterDescription(
  cwd: string,
  agentDir = getAgentDir(),
): string {
  return `${BASE_AGENT_PARAMETER_DESCRIPTION}${formatAvailableAgents(cwd, agentDir)}`;
}

type ResolvedExtensions = Awaited<
  ReturnType<DefaultPackageManager["resolveExtensionSources"]>
>["extensions"];

function namedResources(
  source: string,
  names: readonly string[],
  extensions: ResolvedExtensions,
): string[] {
  const roots = new Set(
    extensions.map((entry) => entry.metadata.packageRoot).filter(Boolean),
  );
  const root = roots.size === 1 ? [...roots][0] : undefined;
  if (!root)
    throw new Error(`Named extension resources require a package: ${source}`);
  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  } catch {
    throw new Error(`Cannot read extension resource declarations: ${source}`);
  }
  const resources =
    manifest && typeof manifest === "object" && "extensionResources" in manifest
      ? manifest.extensionResources
      : undefined;
  if (!resources || typeof resources !== "object" || Array.isArray(resources)) {
    throw new Error(`Package has no extensionResources declaration: ${source}`);
  }
  const approved = new Set(extensions.map((entry) => entry.path));
  const paths: string[] = [];
  for (const rawName of names) {
    const name = rawName.trim();
    if (!Object.hasOwn(resources, name))
      throw new Error(`Unknown extension resource ${name} in ${source}`);
    const value = (resources as Record<string, unknown>)[name];
    const entries = typeof value === "string" ? [value] : value;
    if (!Array.isArray(entries) || !entries.length)
      throw new Error(`Invalid extension resource ${name} in ${source}`);
    for (const entry of entries) {
      if (typeof entry !== "string" || !entry.trim() || isAbsolute(entry))
        throw new Error(
          `Invalid extension resource path for ${name} in ${source}`,
        );
      const path = resolve(root, entry);
      const within = relative(root, path);
      if (
        within === ".." ||
        within.startsWith(`..${sep}`) ||
        isAbsolute(within) ||
        !approved.has(path)
      ) {
        throw new Error(
          `Extension resource ${name} is outside the enabled Pi manifest: ${source}`,
        );
      }
      paths.push(path);
    }
  }
  return paths;
}

/** Pi resolves sources; packages declare logical names. No kit-specific aliases or prefix rules. */
export async function resolveWorkerExtensions(
  sources: readonly WorkerExtensionSource[],
): Promise<string[]> {
  if (!sources.length) return [];
  const agentDir = getAgentDir();
  const packages = new DefaultPackageManager({
    cwd: agentDir,
    agentDir,
    settingsManager: SettingsManager.create(agentDir, agentDir),
  });
  const cache = new Map<string, ResolvedExtensions>();
  const paths = new Set<string>();
  for (const selection of sources) {
    if (typeof selection !== "string" && !selection.extensions.length) continue;
    const source = (
      typeof selection === "string" ? selection : selection.source
    ).trim();
    let extensions = cache.get(source);
    if (!extensions) {
      const resolved = await packages.resolveExtensionSources([source]);
      extensions = resolved.extensions.filter((extension) => extension.enabled);
      if (!extensions.length)
        throw new Error(
          `Extension source resolves to no enabled extensions: ${source}`,
        );
      cache.set(source, extensions);
    }
    const selected =
      typeof selection === "string"
        ? extensions.map((entry) => entry.path)
        : namedResources(source, selection.extensions, extensions);
    for (const path of selected) paths.add(path);
  }
  return [...paths];
}
