import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const kits = ["workspace", "usage", "workflow", "web"];
const entries: string[] = [];

test("four kits explicitly declare nine independent runtime entries", () => {
  for (const kit of kits) {
    const dir = join(root, "packages", `${kit}-kit`);
    const manifest = JSON.parse(
      readFileSync(join(dir, "package.json"), "utf8"),
    );
    assert.equal(manifest.name, `pi-${kit}-kit`);
    assert.ok(manifest.keywords.includes("pi-package"));
    assert.equal(manifest.private, true);
    for (const entry of manifest.pi.extensions) {
      assert.ok(!entry.includes(".test.") && !entry.includes("/lib/"));
      const path = resolve(dir, entry);
      assert.ok(existsSync(path), path);
      entries.push(path);
    }
    for (const name of [
      "@earendil-works/pi-ai",
      "@earendil-works/pi-coding-agent",
      "@earendil-works/pi-tui",
      "typebox",
    ]) {
      assert.equal(
        manifest.dependencies?.[name],
        undefined,
        "host packages must not be runtime dependencies",
      );
    }
  }
  assert.equal(entries.length, 9);
  assert.equal(new Set(entries).size, 9);
});

test("Pi loads all kit manifests in isolation without extension errors", () => {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-kits-smoke-"));
  try {
    const child = spawnSync(
      process.execPath,
      [
        join(
          root,
          "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js",
        ),
        "--no-extensions",
        "--no-context-files",
        "--no-approve",
        "--offline",
        ...kits.flatMap((kit) => ["-e", join(root, "packages", `${kit}-kit`)]),
        "--help",
      ],
      {
        cwd: root,
        env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" },
        encoding: "utf8",
        timeout: 30_000,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    assert.equal(child.error, undefined);
    assert.equal(child.status, 0, child.stderr);
    assert.match(child.stdout, /--commit/);
    assert.doesNotMatch(
      child.stdout + child.stderr,
      /Failed to load|Extension error|duplicate registration/i,
    );
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});
