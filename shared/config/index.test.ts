import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  getAgentDir,
  getPiKitsConfigPath,
  PI_KITS_SCHEMA,
  parsePiKitsConfig,
  parsePiKitsFile,
  readPiKitsConfig,
  readPiKitsFile,
  resolvePiKitsConfig,
  SUBAGENT_DEFAULT_EXTENSIONS,
  updatePiKitsConfig,
} from "./index.ts";

const keys = [
  "pi-canvas-note",
  "pi-open",
  "pi-output-viewer",
  "pi-ask",
  "pi-subagent",
  "pi-web-kits",
] as const;

function invalid(raw: unknown) {
  const text = JSON.stringify(raw);
  assert.throws(() => parsePiKitsFile(text), /Invalid pi-kits.json/);
  assert.throws(() => parsePiKitsConfig(text), /Invalid pi-kits.json/);
  assert.throws(
    () => resolvePiKitsConfig(JSON.parse(text)),
    /Invalid pi-kits.json/,
  );
}

test("schema and resolved configuration expose only current pi-* sections", () => {
  assert.deepEqual(
    Object.keys(PI_KITS_SCHEMA.properties).sort(),
    ["$schema", ...keys].sort(),
  );
  assert.deepEqual(Object.keys(resolvePiKitsConfig()).sort(), [...keys].sort());
});

test("absent config uses defaults without creating a file", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-kits-config-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.equal(readPiKitsFile(dir), undefined);
  const config = readPiKitsConfig(dir);
  for (const key of keys) assert.equal(config[key].enabled, true);
  assert.deepEqual(config["pi-output-viewer"], {
    enabled: true,
    editor: "nvim",
  });
  assert.deepEqual(config["pi-canvas-note"], {
    enabled: true,
    host: undefined,
    portRange: [10000, 20000],
  });
  assert.deepEqual(config["pi-subagent"], {
    enabled: true,
    maxConcurrent: 4,
    extensionAllowlist: [...SUBAGENT_DEFAULT_EXTENSIONS],
  });
  const web = config["pi-web-kits"];
  assert.deepEqual(web.search.sources, {
    web: {
      enabled: true,
      routing: ["searxng"],
      codex: { model: "gpt-6-luna" },
    },
    github: { enabled: true },
  });
  assert.equal(web.search.timeoutMs, 15000);
  assert.equal(web.search.maxResults, 5);
  assert.deepEqual(web.fetch, {
    enabled: true,
    timeoutMs: 15000,
    github: { enabled: true },
  });
  assert.equal(readPiKitsFile(dir), undefined);
});

for (const key of keys) {
  test(`${key} independently controls its extension`, () => {
    const config = parsePiKitsConfig(
      JSON.stringify({ [key]: { enabled: false } }),
    );
    for (const current of keys)
      assert.equal(config[current].enabled, current !== key);
    invalid({ [key]: null });
    invalid({ [key]: { enabled: "false" } });
  });
}

test("removed aliases, archived settings and groups stay raw but never affect settings", () => {
  const raw = {
    terminal: { editor: "ignored", enabled: false },
    open: { enabled: false },
    preview: { enabled: false },
    askUserQuestion: { enabled: false },
    subagent: { maxConcurrent: 1 },
    "canvas-note": { portRange: [20000, 10000] },
    "web-kits": { enabled: false, search: { maxResults: 0 } },
    workspace: { enabled: false },
    workflow: { enabled: false },
    usage: { enabled: false },
    commit: null,
    stats: 42,
    notify: "ignored",
    providerUsage: { intervalMs: 0 },
    contextPreview: false,
  };
  assert.deepEqual(parsePiKitsFile(JSON.stringify(raw)), raw);
  assert.deepEqual(
    parsePiKitsConfig(JSON.stringify(raw)),
    resolvePiKitsConfig(),
  );
  const config = parsePiKitsConfig(
    JSON.stringify({ ...raw, "pi-output-viewer": { editor: "hx" } }),
  );
  assert.equal(config["pi-output-viewer"].editor, "hx");
  assert.equal(config["pi-open"].enabled, true);
});

test("unknown fields are preserved without becoming runtime settings", () => {
  const raw = JSON.parse(
    '{"future":{"enabled":false},"pi-subagent":{"unknown":null,"__proto__":{"maxConcurrent":0}},"pi-output-viewer":{"future":true}}',
  );
  assert.deepEqual(parsePiKitsFile(JSON.stringify(raw)), raw);
  assert.deepEqual(resolvePiKitsConfig(raw), resolvePiKitsConfig());
  assert.equal(Object.hasOwn(Object.prototype, "maxConcurrent"), false);
});

test("canvas settings and ordered port ranges use only the canonical key", () => {
  assert.deepEqual(
    parsePiKitsConfig(
      '{"pi-canvas-note":{"host":"127.0.0.1","portRange":[12000,14000]}}',
    )["pi-canvas-note"],
    {
      enabled: true,
      host: "127.0.0.1",
      portRange: [12000, 14000],
    },
  );
  for (const portRange of [
    [0, 20000],
    [20000, 10000],
    [10000, 65536],
    [1.5, 3],
    [10000],
    [1, 2, 3],
    "invalid",
  ]) {
    invalid({ "pi-canvas-note": { portRange } });
  }
  invalid({ "pi-canvas-note": { host: " " } });
  invalid({ "pi-output-viewer": { editor: " " } });
});

test("worker allowlists replace defaults and isolate package selections", () => {
  for (const extensionAllowlist of [
    [],
    ["builtin:mcp", "/trusted/custom.ts"],
    ["npm:@narumitw/pi-chrome-devtools", "git:github.com/example/tools"],
    [{ source: "git:github.com/aqua2k1/pi-kits", extensions: ["pi-web-kits"] }],
    [{ source: "package", extensions: [] }],
  ]) {
    const raw = parsePiKitsFile(
      JSON.stringify({ "pi-subagent": { extensionAllowlist } }),
    );
    const config = resolvePiKitsConfig(raw)["pi-subagent"];
    assert.deepEqual(config.extensionAllowlist, extensionAllowlist);
    assert.notEqual(config.extensionAllowlist, extensionAllowlist);
    for (const entry of config.extensionAllowlist)
      if (typeof entry !== "string") entry.extensions.length = 0;
    config.extensionAllowlist.length = 0;
    assert.deepEqual(
      raw["pi-subagent"]?.extensionAllowlist,
      extensionAllowlist,
    );
  }
  for (const extensionAllowlist of [
    null,
    "builtin:codemode",
    [""],
    [" "],
    [false],
    ["x", "x"],
    ["x\n"],
    [{ source: "x" }],
    [{ source: "x", extensions: [""] }],
    [{ source: "x", extensions: ["pi-web-kits", "pi-web-kits"] }],
  ])
    invalid({ "pi-subagent": { extensionAllowlist } });
  for (const maxConcurrent of [1, 32])
    assert.equal(
      resolvePiKitsConfig({ "pi-subagent": { maxConcurrent } })["pi-subagent"]
        .maxConcurrent,
      maxConcurrent,
    );
  for (const maxConcurrent of [0, 33, 1.5, "4"])
    invalid({ "pi-subagent": { maxConcurrent } });
});

test("web capability routing arrays and model settings retain their independent contracts", () => {
  const raw = {
    sources: {
      web: {
        routing: ["codex-alpha-search", "searxng"],
        codex: { model: "custom-model" },
      },
      github: { enabled: false },
    },
  };
  const config = parsePiKitsConfig(
    JSON.stringify({ "pi-web-kits": { search: raw } }),
  )["pi-web-kits"].search;
  assert.deepEqual(config.routing, {
    provider: "codex-alpha-search",
    fallback: true,
    fallbackProvider: "searxng",
  });
  assert.equal(config.codex.model, "custom-model");
  assert.equal(config.sources.github.enabled, false);
  config.sources.web.routing.length = 0;
  assert.deepEqual(raw.sources.web.routing, ["codex-alpha-search", "searxng"]);

  for (const provider of ["searxng", "codex"] as const) {
    const legacyLayout = resolvePiKitsConfig({
      "pi-web-kits": { search: { routing: { provider, fallback: true } } },
    })["pi-web-kits"].search;
    assert.equal(legacyLayout.sources.web.routing.length, 2);
    assert.notEqual(
      legacyLayout.sources.web.routing[0],
      legacyLayout.sources.web.routing[1],
    );
  }
  assert.equal(
    resolvePiKitsConfig({
      "pi-web-kits": { search: { codex: { model: "gpt-5.4" } } },
    })["pi-web-kits"].search.codex.model,
    "gpt-5.4",
  );
});

for (const search of [
  { sources: null },
  { sources: { web: false } },
  { sources: { github: { enabled: 1 } } },
  ...[[], ["searxng", "searxng"], ["unknown"], ["codex"], "searxng"].map(
    (routing) => ({ sources: { web: { routing } } }),
  ),
  { sources: { web: { codex: { model: "bad model" } } } },
  { sources: { web: {} }, routing: {} },
  { sources: { web: {} }, codex: {} },
  { sources: { web: { enabled: false }, github: { enabled: false } } },
  { enabled: false, sources: { web: {} }, routing: {} },
  { routing: { provider: "invalid" } },
  { routing: { provider: "codex", fallbackProvider: "codex-alpha-search" } },
  { routing: { fallbackProvider: "searxng" } },
  { timeoutMs: 999 },
  { timeoutMs: 120001 },
  { maxResults: 0 },
  { maxResults: 11 },
  { searxng: { apiKey: "secret" } },
  { sources: { web: { searxng: { url: "https://example.com" } } } },
]) {
  test(`invalid canonical web search is rejected: ${JSON.stringify(search)}`, () =>
    invalid({ "pi-web-kits": { search } }));
}

test("explicit false values remain independent and a disabled search may have no capabilities", () => {
  const config = resolvePiKitsConfig({
    "pi-web-kits": {
      search: {
        enabled: false,
        sources: { web: { enabled: false }, github: { enabled: false } },
      },
      fetch: { github: { enabled: false } },
    },
  })["pi-web-kits"];
  assert.equal(config.search.enabled, false);
  assert.equal(config.fetch.enabled, true);
  assert.equal(config.fetch.github.enabled, false);
  invalid({ "pi-web-kits": { fetch: { timeoutMs: 0 } } });
});

test("unknown obsolete GitHub fields remain raw but are ignored", () => {
  const github = {
    enabled: false,
    mode: {},
    maxRepoSizeMB: "invalid",
    clonePath: 42,
  };
  const raw = parsePiKitsFile(
    JSON.stringify({ "pi-web-kits": { fetch: { github } } }),
  );
  assert.deepEqual(raw["pi-web-kits"]?.fetch?.github, github);
  assert.deepEqual(resolvePiKitsConfig(raw)["pi-web-kits"].fetch.github, {
    enabled: false,
  });
});

test("fresh snapshots pick up edits and default arrays are isolated", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-kits-config-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(getPiKitsConfigPath(dir), '{"pi-open":{"enabled":false}}');
  const first = readPiKitsConfig(dir);
  assert.equal(first["pi-open"].enabled, false);
  first["pi-subagent"].extensionAllowlist.length = 0;
  first["pi-web-kits"].search.sources.web.routing.length = 0;
  first["pi-canvas-note"].portRange[0] = 1;
  writeFileSync(getPiKitsConfigPath(dir), "{}");
  const second = readPiKitsConfig(dir);
  assert.equal(second["pi-open"].enabled, true);
  assert.deepEqual(second["pi-subagent"].extensionAllowlist, [
    ...SUBAGENT_DEFAULT_EXTENSIONS,
  ]);
  assert.deepEqual(second["pi-web-kits"].search.sources.web.routing, [
    "searxng",
  ]);
  assert.deepEqual(second["pi-canvas-note"].portRange, [10000, 20000]);
});

test("invalid and unreadable files never fall back to defaults", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-kits-invalid-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const text of ["{", "null", "[]", '{"pi-open":{"enabled":"false"}}']) {
    writeFileSync(getPiKitsConfigPath(dir), text);
    assert.throws(() => readPiKitsConfig(dir), /Invalid pi-kits.json/);
  }
  rmSync(getPiKitsConfigPath(dir));
  mkdirSync(getPiKitsConfigPath(dir));
  assert.throws(() => readPiKitsConfig(dir), /Could not read/);
});

test("agent-directory overrides and home expansion use Pi semantics", (t) => {
  const original = process.env.PI_CODING_AGENT_DIR;
  t.after(() => {
    if (original === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = original;
  });
  process.env.PI_CODING_AGENT_DIR = "/tmp/pi-kits-custom-agent";
  assert.equal(getPiKitsConfigPath(), "/tmp/pi-kits-custom-agent/pi-kits.json");
  process.env.PI_CODING_AGENT_DIR = "~/pi-kits-custom-agent";
  assert.ok(!getAgentDir().includes("~"));
});

test("atomic updates preserve unknown fields and reject invalid settings before writing", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-kits-update-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(
    getPiKitsConfigPath(dir),
    '{"future":{"value":true},"subagent":{"maxConcurrent":1}}',
  );
  updatePiKitsConfig(
    (raw) => ({ ...raw, "pi-subagent": { maxConcurrent: 2 } }),
    dir,
  );
  assert.equal(readPiKitsConfig(dir)["pi-subagent"].maxConcurrent, 2);
  assert.deepEqual(JSON.parse(readFileSync(getPiKitsConfigPath(dir), "utf8")), {
    future: { value: true },
    subagent: { maxConcurrent: 1 },
    "pi-subagent": { maxConcurrent: 2 },
  });
  const before = readFileSync(getPiKitsConfigPath(dir), "utf8");
  assert.throws(
    () =>
      updatePiKitsConfig(
        (raw) => ({ ...raw, "pi-subagent": { maxConcurrent: 0 } }),
        dir,
      ),
    /Invalid pi-kits.json/,
  );
  assert.equal(readFileSync(getPiKitsConfigPath(dir), "utf8"), before);
});

test("published schema and example match runtime validation and contain no aliases", () => {
  assert.deepEqual(
    JSON.parse(
      readFileSync(
        new URL("../../pi-kits.schema.json", import.meta.url),
        "utf8",
      ),
    ),
    JSON.parse(JSON.stringify(PI_KITS_SCHEMA)),
  );
  const raw = parsePiKitsFile(
    readFileSync(
      new URL("../../pi-kits.example.json", import.meta.url),
      "utf8",
    ),
  );
  assert.deepEqual(Object.keys(raw).sort(), ["$schema", ...keys].sort());
  assert.deepEqual(raw["pi-output-viewer"], { enabled: true, editor: "nvim" });
  assert.deepEqual(resolvePiKitsConfig(raw)["pi-subagent"].extensionAllowlist, [
    ...SUBAGENT_DEFAULT_EXTENSIONS,
    { source: "git:github.com/aqua2k1/pi-kits", extensions: [] },
  ]);
});
