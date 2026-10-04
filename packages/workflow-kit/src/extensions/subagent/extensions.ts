import {
  DefaultPackageManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@pi-kits/config";

/** Delegate all source syntax and manifest discovery to Pi, never classify prefixes. */
export async function resolveWorkerExtensions(
  sources: readonly string[],
): Promise<string[]> {
  if (!sources.length) return [];
  const agentDir = getAgentDir();
  const packages = new DefaultPackageManager({
    cwd: agentDir,
    agentDir,
    settingsManager: SettingsManager.create(agentDir, agentDir),
  });
  const paths = new Set<string>();
  for (const source of new Set(sources.map((entry) => entry.trim()))) {
    const resolved = await packages.resolveExtensionSources([source]);
    const extensions = resolved.extensions.filter(
      (extension) => extension.enabled,
    );
    if (!extensions.length)
      throw new Error(
        `Extension source resolves to no enabled extensions: ${source}`,
      );
    for (const extension of extensions) paths.add(extension.path);
  }
  return [...paths];
}
