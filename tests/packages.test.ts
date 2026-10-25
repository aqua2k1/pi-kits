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

test("Canvas Note prompt loads from root and independent packages and expands complete requests", async (t) => {
  const { DefaultResourceLoader, SettingsManager } = await import(
    "@earendil-works/pi-coding-agent"
  );
  const { expandPromptTemplate } = await import(
    new URL(
      "../node_modules/@earendil-works/pi-coding-agent/dist/core/prompt-templates.js",
      import.meta.url,
    ).href
  );
  const expected = join(root, "extensions/canvas-note/prompts/canvas-note.md");
  for (const source of [root, join(root, "extensions/canvas-note")]) {
    const manifest = JSON.parse(
      readFileSync(join(source, "package.json"), "utf8"),
    );
    assert.deepEqual(
      manifest.pi.prompts.map((entry: string) => resolve(source, entry)),
      [expected],
    );
    const dir = mkdtempSync(join(tmpdir(), "pi-kits-prompt-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const loader = new DefaultResourceLoader({
      cwd: dir,
      agentDir: dir,
      settingsManager: SettingsManager.inMemory({
        packages: [{ source, extensions: [], skills: [], themes: [] }],
      }),
      noExtensions: true,
      noSkills: true,
      noThemes: true,
      noContextFiles: true,
    });
    await loader.reload();
    const { prompts, diagnostics } = loader.getPrompts();
    assert.deepEqual(diagnostics, []);
    assert.equal(prompts.length, 1);
    const prompt = prompts[0];
    assert.equal(prompt.name, "canvas-note");
    assert.equal(prompt.argumentHint, "<msg>");
    assert.equal(prompt.filePath, expected);
    assert.equal(
      prompt.description,
      "Create or update interactive documents with Canvas Note",
    );
    assert.ok(prompt.content.includes("$ARGUMENTS"));
    const expanded = expandPromptTemplate(
      '/canvas-note Analyze "API compatibility" and draw a chart',
      prompts,
    );
    assert.ok(
      expanded.endsWith(
        "User request:\nAnalyze API compatibility and draw a chart",
      ),
    );
    assert.equal(expanded.includes("$ARGUMENTS"), false);
    const empty = expandPromptTemplate("/canvas-note", prompts);
    assert.ok(
      empty.includes(
        "If no request is provided, ask what the user wants to create or change.",
      ),
    );
    assert.equal(empty.includes("$ARGUMENTS"), false);
    assert.equal(
      expandPromptTemplate("/another-command request", prompts),
      "/another-command request",
    );
  }
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
