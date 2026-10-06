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
const extensions = [
  "open",
  "preview",
  "context-preview",
  "provider-usage",
  "stats",
  "commit",
  "notify",
  "ask-user-question",
  "subagent",
  "web-kits",
];

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

test("ten flat extensions explicitly declare their independent runtime entries", () => {
  const entries: string[] = [];
  for (const name of extensions) {
    const dir = join(root, "extensions", name);
    const manifest = JSON.parse(
      readFileSync(join(dir, "package.json"), "utf8"),
    );
    assert.equal(manifest.name, name === "web-kits" ? name : `pi-${name}`);
    assert.deepEqual(Object.keys(manifest.extensionResources), [name]);
    assert.deepEqual(manifest.pi.extensions, ["./index.ts"]);
    assert.ok(manifest.keywords.includes("pi-package"));
    assert.equal(manifest.private, true);
    assert.equal(manifest.version, undefined);
    const declared = manifest.extensionResources[name];
    assert.deepEqual(
      typeof declared === "string" ? [declared] : declared,
      manifest.pi.extensions,
    );
    for (const entry of manifest.pi.extensions) {
      assert.ok(!entry.includes(".test.") && !entry.includes("/lib/"));
      assert.ok(
        !entry.endsWith("/worker.ts"),
        "workers load only via explicit -e",
      );
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
    assert.equal(manifest.dependencies["@pi-kits/config"], "*");
    if (name !== "web-kits") {
      assert.equal(manifest.dependencies["@pi-kits/shared"], "*");
    }
  }
  assert.equal(entries.length, 10);
  assert.equal(new Set(entries).size, 10);
  const repository = JSON.parse(
    readFileSync(join(root, "package.json"), "utf8"),
  );
  assert.equal(repository.version, undefined);
  assert.ok(repository.keywords.includes("pi-package"));
  assert.deepEqual(Object.keys(repository.extensionResources), extensions);
  const named = Object.values(repository.extensionResources).flatMap((value) =>
    typeof value === "string" ? [value] : (value as string[]),
  );
  assert.deepEqual(
    [...new Set(named)],
    repository.pi.extensions,
    "Named resources must expose exactly the explicit manifest entries",
  );
  assert.deepEqual(
    repository.pi.extensions.map((entry: string) => resolve(root, entry)),
    entries,
    "Git repository manifest must expose exactly the independent extension entries",
  );
});

test("flat resource declarations select web-kits without legacy aliases", async () => {
  const { resolveWorkerExtensions } = await import(
    "../extensions/subagent/runtime/pi/extensions.ts"
  );
  assert.deepEqual(
    await resolveWorkerExtensions([
      { source: root, extensions: ["stats", "web-kits"] },
    ]),
    [
      join(root, "extensions/stats/index.ts"),
      join(root, "extensions/web-kits/index.ts"),
    ],
  );
  assert.deepEqual(
    await resolveWorkerExtensions([
      { source: join(root, "extensions/stats"), extensions: ["stats"] },
    ]),
    [join(root, "extensions/stats/index.ts")],
  );
  assert.deepEqual(
    await resolveWorkerExtensions([
      { source: join(root, "extensions/web-kits"), extensions: ["web-kits"] },
    ]),
    [join(root, "extensions/web-kits/index.ts")],
  );
  for (const name of [
    "workspace-kit",
    "usage-kit",
    "workflow-kit",
    "web-kit",
    "web",
  ]) {
    await assert.rejects(
      resolveWorkerExtensions([{ source: root, extensions: [name] }]),
      /Unknown extension resource/,
    );
  }
});

test("repository declares an independent valid Gruvbox theme", async () => {
  const repository = JSON.parse(
    readFileSync(join(root, "package.json"), "utf8"),
  );
  const dir = join(root, "themes");
  const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  assert.equal(manifest.version, undefined);
  assert.ok(manifest.keywords.includes("pi-package"));
  assert.deepEqual(manifest.pi.themes, ["./gruvbox.json"]);
  assert.deepEqual(repository.pi.themes, ["./themes/gruvbox.json"]);
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
    "individual extension packages",
    [
      ...extensions.map((name) => join(root, "extensions", name)),
      join(root, "themes"),
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
      "web-kits": { enabled: false },
    }),
  );
  assert.doesNotMatch(smoke([root], dir), /--commit/);
});

test("Git package loads with production-only workspace dependencies", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-kits-production-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const checkout = join(dir, "checkout");
  for (const entry of [
    "package.json",
    "package-lock.json",
    "extensions",
    "shared",
    "themes",
  ]) {
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
