import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Value } from "typebox/value";

const root = fileURLToPath(new URL("../", import.meta.url));
const extensions = readdirSync(join(root, "extensions"), {
  withFileTypes: true,
})
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

type Resources = Record<string, string | string[]>;

function resourceEntries(dir: string, resources: Resources) {
  return Object.entries(resources)
    .map(([name, paths]) => {
      assert.ok(name.trim(), "Resource names must not be blank");
      const entries = typeof paths === "string" ? [paths] : paths;
      assert.ok(entries.length > 0, `Resource ${name} must declare entries`);
      return [
        name,
        entries.map((entry) => resolve(dir, entry)).sort(),
      ] as const;
    })
    .sort(([a], [b]) => a.localeCompare(b));
}

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

test("repository and independent extension manifests declare the same explicit entries and resources", () => {
  assert.ok(extensions.length > 0, "No extension packages discovered");
  const entries: string[] = [];
  const resources: ReturnType<typeof resourceEntries> = [];
  for (const name of extensions) {
    const dir = join(root, "extensions", name);
    const manifest = JSON.parse(
      readFileSync(join(dir, "package.json"), "utf8"),
    );
    assert.ok(manifest.keywords.includes("pi-package"));
    assert.match(
      manifest.name,
      /^pi-/u,
      `${name}: package name must use the pi-* prefix`,
    );
    assert.equal(
      manifest.name,
      name,
      `${name}: folder and package names must match`,
    );
    assert.ok(Array.isArray(manifest.pi.extensions));
    assert.ok(
      manifest.pi.extensions.length > 0,
      `${name} must declare entries`,
    );
    const declared = resourceEntries(dir, manifest.extensionResources);
    assert.deepEqual(
      [...new Set(declared.flatMap(([, paths]) => paths))].sort(),
      manifest.pi.extensions.map((entry: string) => resolve(dir, entry)).sort(),
      `${name}: named resources must cover exactly the explicit entries`,
    );
    resources.push(...declared);
    for (const entry of manifest.pi.extensions) {
      assert.ok(!/[*?[\]{}]/u.test(entry), "Entries must be explicit paths");
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
  }
  assert.equal(
    new Set(entries).size,
    entries.length,
    "Duplicate extension entries",
  );
  assert.equal(
    new Set(resources.map(([name]) => name)).size,
    resources.length,
    "Logical resource names must be unique across extension packages",
  );
  const repository = JSON.parse(
    readFileSync(join(root, "package.json"), "utf8"),
  );
  assert.ok(repository.keywords.includes("pi-package"));
  assert.deepEqual(
    resourceEntries(root, repository.extensionResources),
    resources.sort(([a], [b]) => a.localeCompare(b)),
    "Root resources must match the independent packages",
  );
  assert.deepEqual(
    repository.pi.extensions
      .map((entry: string) => resolve(root, entry))
      .sort(),
    entries.sort(),
    "Git repository manifest must expose exactly the independent extension entries",
  );
});

test("Canvas Note skill loads manually from root and independent packages without a prompt template", async (t) => {
  const { DefaultResourceLoader, SettingsManager } = await import(
    "@earendil-works/pi-coding-agent"
  );
  const { formatSkillsForPrompt } = await import(
    new URL(
      "../node_modules/@earendil-works/pi-coding-agent/dist/core/skills.js",
      import.meta.url,
    ).href
  );
  const skillDir = join(root, "extensions/pi-canvas-note/skills/canvas-note");
  const expected = join(skillDir, "SKILL.md");
  for (const source of [root, join(root, "extensions/pi-canvas-note")]) {
    const manifest = JSON.parse(
      readFileSync(join(source, "package.json"), "utf8"),
    );
    assert.deepEqual(
      manifest.pi.skills.map((entry: string) => resolve(source, entry)),
      [skillDir],
    );
    assert.equal(manifest.pi.prompts, undefined);
    const dir = mkdtempSync(join(tmpdir(), "pi-kits-skill-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const loader = new DefaultResourceLoader({
      cwd: dir,
      agentDir: dir,
      settingsManager: SettingsManager.inMemory({
        packages: [{ source, extensions: [], prompts: [], themes: [] }],
      }),
      noExtensions: true,
      noThemes: true,
      noContextFiles: true,
    });
    await loader.reload();
    const { skills, diagnostics } = loader.getSkills();
    assert.deepEqual(diagnostics, []);
    const canvasSkills = skills.filter((skill) => skill.name === "canvas-note");
    assert.equal(canvasSkills.length, 1);
    const skill = canvasSkills[0];
    assert.equal(skill.name, "canvas-note");
    assert.equal(skill.filePath, expected);
    assert.equal(skill.disableModelInvocation, true);
    assert.equal(formatSkillsForPrompt(canvasSkills), "");
    assert.ok(!formatSkillsForPrompt(skills).includes(expected));
    assert.deepEqual(loader.getPrompts().prompts, []);
    const instructions = readFileSync(skill.filePath, "utf8");
    assert.match(instructions, /searchTools/);
    assert.match(instructions, /describeNamespace/);
    assert.match(instructions, /snapshotPath/);
    assert.match(instructions, /documentPath/);
    assert.equal(instructions.includes("$ARGUMENTS"), false);
  }
});

test("flat resource declarations select web-kits without legacy aliases", async () => {
  const { resolveWorkerExtensions } = await import(
    "../extensions/pi-subagent/runtime/pi/extensions.ts"
  );
  assert.deepEqual(
    await resolveWorkerExtensions([
      { source: root, extensions: ["open", "web-kits"] },
    ]),
    [
      join(root, "extensions/pi-open/index.ts"),
      join(root, "extensions/pi-web-kits/index.ts"),
    ],
  );
  assert.deepEqual(
    await resolveWorkerExtensions([
      { source: join(root, "extensions/pi-open"), extensions: ["open"] },
    ]),
    [join(root, "extensions/pi-open/index.ts")],
  );
  assert.deepEqual(
    await resolveWorkerExtensions([
      {
        source: join(root, "extensions/pi-web-kits"),
        extensions: ["web-kits"],
      },
    ]),
    [join(root, "extensions/pi-web-kits/index.ts")],
  );
  for (const name of [
    "stats",
    "provider-usage",
    "notify",
    "context-preview",
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
  assert.equal(theme.$schema, "https://pi.dev/schemas/theme.schema.json");
  const schemaPath = new URL(
    "../schemas/theme.schema.json",
    import.meta.resolve("@earendil-works/pi-coding-agent"),
  );
  const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
  assert.equal(
    Value.Check(schema, theme),
    true,
    "Gruvbox must satisfy Pi's published schema",
  );
  assert.equal(Value.Check(schema, { ...theme, name: 42 }), false);
  assert.equal(Value.Check(schema, { ...theme, colors: {} }), false);
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
    assert.doesNotMatch(smoke(paths, dir), /--commit/);
  });
}

test("legacy disabled groups remain accepted by the real Pi loader", (t) => {
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
  assert.doesNotMatch(smoke([checkout], dir), /--commit/);
});
