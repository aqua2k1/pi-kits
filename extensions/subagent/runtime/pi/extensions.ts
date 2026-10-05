import { readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  DefaultPackageManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { getAgentDir, type WorkerExtensionSource } from "@pi-kits/config";

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
