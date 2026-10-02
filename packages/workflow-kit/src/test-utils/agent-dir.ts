import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";

const agentDirs = new WeakMap<TestContext, string>();

/** Keep factory tests away from the user's configuration and runtime state. */
export function useAgentDir(t: TestContext, config?: unknown): string {
  const existing = agentDirs.get(t);
  if (existing !== undefined) {
    if (config !== undefined) {
      writeFileSync(
        path.join(existing, "pi-kits.json"),
        JSON.stringify(config),
      );
    }
    return existing;
  }
  const dir = mkdtempSync(path.join(os.tmpdir(), "workflow-agent-"));
  agentDirs.set(t, dir);
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  if (config !== undefined) {
    writeFileSync(path.join(dir, "pi-kits.json"), JSON.stringify(config));
  }
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}
