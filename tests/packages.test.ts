import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const kits = ["workspace", "usage", "workflow", "web"];

function smoke(paths: readonly string[], agentDir: string): string {
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
      ...paths.flatMap((path) => ["-e", path]),
      "--help",
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        PI_CODING_AGENT_DIR: agentDir,
        PI_OFFLINE: "1",
        TMPDIR: agentDir,
      },
      encoding: "utf8",
      timeout: 30_000,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0, child.stderr);
  assert.doesNotMatch(
    child.stdout + child.stderr,
    /Failed to load|Extension error|duplicate registration|Error loading/i,
  );
  return child.stdout;
}

test("four kits explicitly declare ten independent runtime entries", () => {
  const entries: string[] = [];
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
    assert.equal(manifest.dependencies["@pi-kits/config"], "0.1.0");
  }
  assert.equal(entries.length, 10);
  assert.equal(new Set(entries).size, 10);
  const repository = JSON.parse(
    readFileSync(join(root, "package.json"), "utf8"),
  );
  assert.ok(repository.keywords.includes("pi-package"));
  assert.deepEqual(
    repository.pi.extensions.map((entry: string) => resolve(root, entry)),
    entries,
    "Git repository manifest must expose exactly the kit entries",
  );
});

test("repository declares an independent valid Gruvbox theme", async () => {
  const repository = JSON.parse(
    readFileSync(join(root, "package.json"), "utf8"),
  );
  const dir = join(root, "packages/themes");
  const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  assert.ok(manifest.keywords.includes("pi-package"));
  assert.deepEqual(manifest.pi.themes, ["./gruvbox.json"]);
  assert.deepEqual(repository.pi.themes, ["./packages/themes/gruvbox.json"]);
  assert.deepEqual(
    repository.pi.themes.map((entry: string) => resolve(root, entry)),
    manifest.pi.themes.map((entry: string) => resolve(dir, entry)),
  );
  const theme = JSON.parse(
    readFileSync(resolve(root, repository.pi.themes[0]), "utf8"),
  );
  assert.equal(theme.name, "gruvbox");
  const { validateThemeJson } = await import(
    new URL(
      "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme-json.js",
      import.meta.url,
    ).href
  );
  assert.doesNotThrow(() => validateThemeJson("gruvbox", theme));
  for (const color of Object.values(theme.colors)) {
    assert.ok(typeof color === "string" && color in theme.vars);
  }
});

for (const [name, paths] of [
  [
    "individual kits",
    [
      ...kits.map((kit) => join(root, "packages", `${kit}-kit`)),
      join(root, "packages/themes"),
    ],
  ],
  ["Git repository root", [root]],
] as const) {
  test(`Pi loads ${name} in isolation without extension errors`, (t) => {
    const dir = mkdtempSync(join(tmpdir(), "pi-kits-smoke-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    assert.match(smoke(paths, dir), /--commit/);
  });
}

test("unified config disables all kit entries in the real Pi loader", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-kits-disabled-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(
    join(dir, "pi-kits.json"),
    JSON.stringify({
      workspace: { enabled: false },
      usage: { enabled: false },
      workflow: { enabled: false },
      web: { enabled: false },
    }),
  );
  assert.doesNotMatch(smoke([root], dir), /--commit/);
});

test("Git package loads with production-only workspace dependencies", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-kits-production-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const checkout = join(dir, "checkout");
  for (const entry of ["package.json", "package-lock.json", "packages"]) {
    cpSync(join(root, entry), join(checkout, entry), {
      recursive: true,
      filter: (path) => basename(path) !== "node_modules",
    });
  }
  const install = spawnSync(
    "npm",
    [
      "ci",
      "--omit=dev",
      "--legacy-peer-deps",
      "--ignore-scripts",
      "--offline",
      "--no-audit",
      "--no-fund",
    ],
    { cwd: checkout, encoding: "utf8", timeout: 30_000 },
  );
  assert.equal(install.error, undefined);
  assert.equal(install.status, 0, install.stderr);
  assert.ok(existsSync(join(checkout, "node_modules/@pi-kits/config")));
  assert.equal(existsSync(join(checkout, "node_modules/typebox")), false);
  assert.match(smoke([checkout], dir), /--commit/);
});
