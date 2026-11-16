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

test("search sources default, derive legacy routes, and isolate routing arrays", () => {
  const defaults = resolvePiKitsConfig()["web-kits"].search;
  assert.deepEqual(defaults.sources, {
    web: {
      enabled: true,
      routing: ["searxng"],
      codex: { model: "gpt-6-luna" },
    },
    github: { enabled: true },
  });
  const current = {
    sources: {
      web: {
        routing: ["codex-alpha-search", "searxng"],
        codex: { model: "custom" },
      },
      github: { enabled: false },
    },
  };
  const config = parsePiKitsConfig(
    JSON.stringify({ "web-kits": { search: current } }),
  )["web-kits"].search;
  assert.deepEqual(config.routing, {
    provider: "codex-alpha-search",
    fallback: true,
    fallbackProvider: "searxng",
  });
  assert.equal(config.codex.model, "custom");
  assert.equal(config.sources.github.enabled, false);
  config.sources.web.routing.length = 0;
  assert.deepEqual(current.sources.web.routing, [
    "codex-alpha-search",
    "searxng",
  ]);
  defaults.sources.web.routing.length = 0;
  assert.deepEqual(
    resolvePiKitsConfig()["web-kits"].search.sources.web.routing,
    ["searxng"],
  );

  for (const provider of ["searxng", "codex"] as const) {
    const legacy = resolvePiKitsConfig({
      "web-kits": { search: { routing: { provider, fallback: true } } },
    })["web-kits"].search;
    assert.equal(legacy.sources.web.routing.length, 2);
    assert.notEqual(...(legacy.sources.web.routing as [string, string]));
  }
});

test("search rejects malformed sources and mixed web formats at every shared entry", () => {
  const invalidSearches = [
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
  ];
  for (const search of invalidSearches) {
    const text = JSON.stringify({ "web-kits": { search } });
    assert.throws(() => parsePiKitsFile(text), /Invalid pi-kits.json/);
    assert.throws(() => parsePiKitsConfig(text), /Invalid pi-kits.json/);
    assert.throws(
      () => resolvePiKitsConfig(JSON.parse(text)),
      /Invalid pi-kits.json/,
    );
  }
  for (const search of [
    { sources: { web: { enabled: false } } },
    { sources: { github: { enabled: false } } },
    {
      enabled: false,
      sources: { web: { enabled: false }, github: { enabled: false } },
    },
    { routing: { provider: "codex" }, sources: { github: { enabled: false } } },
  ]) {
    assert.doesNotThrow(() =>
      parsePiKitsConfig(JSON.stringify({ "web-kits": { search } })),
    );
  }
});

test("absent config uses defaults without creating a file", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-kits-config-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.equal(readPiKitsFile(dir), undefined);
  const config = readPiKitsConfig(dir);
  assert.equal(config.terminal.editor, "nvim");
  assert.equal(config.terminal.gitUI, "lazygit");
  assert.equal(config.terminal.fileManager, "yazi");
  assert.equal(config.providerUsage.intervalMs, 600_000);
  assert.equal(config.providerUsage.timeoutMs, 15_000);
  assert.equal(config.commit.timeoutMs, 120_000);
  assert.equal(config.commit.rememberModel, true);
  assert.equal(config.notify.quietPeriodMs, 1_000);
  assert.deepEqual(config.subagent, {
    enabled: true,
    maxConcurrent: 4,
    extensionAllowlist: [...SUBAGENT_DEFAULT_EXTENSIONS],
  });
  assert.equal(config["web-kits"].search.enabled, true);
  assert.equal(config["web-kits"].search.routing.provider, "searxng");
  assert.equal(config["web-kits"].search.timeoutMs, 15_000);
  assert.equal(config["web-kits"].search.maxResults, 5);
  assert.equal(config["web-kits"].search.codex.model, "gpt-6-luna");
  assert.equal(config["web-kits"].fetch.timeoutMs, 15_000);
  assert.deepEqual(config["web-kits"].fetch.github, { enabled: true });
  assert.equal(readPiKitsFile(dir), undefined);
});

test("canvas defaults, overrides and port-range validation", () => {
  assert.deepEqual(resolvePiKitsConfig()["canvas-note"], {
    enabled: true,
    host: undefined,
    portRange: [10000, 20000],
  });
  assert.deepEqual(
    parsePiKitsConfig(
      '{"canvas-note":{"enabled":false,"host":"0.0.0.0","portRange":[12000,14000]}}',
    )["canvas-note"],
    { enabled: false, host: "0.0.0.0", portRange: [12000, 14000] },
  );
  for (const portRange of [
    [0, 20000],
    [20000, 10000],
    [10000, 65536],
    [1.5, 3],
    [10000],
    [10000, 20000, 30000],
    "10000-20000",
  ]) {
    assert.throws(
      () => parsePiKitsFile(JSON.stringify({ "canvas-note": { portRange } })),
      /Invalid pi-kits.json/,
    );
  }
});

test("explicit Codex model overrides the default", () => {
  const config = parsePiKitsConfig(
    '{"web-kits":{"search":{"codex":{"model":"gpt-5.4"}}}}',
  );
  assert.equal(config["web-kits"].search.codex.model, "gpt-5.4");
});

test("web-kits is the sole web configuration key", () => {
  const config = parsePiKitsConfig(
    '{"web-kits":{"enabled":false,"search":{"maxResults":2}}}',
  );
  assert.equal(config["web-kits"].enabled, false);
  assert.equal(config["web-kits"].search.maxResults, 2);
  assert.ok(!("web" in config));
  assert.equal(
    parsePiKitsConfig('{"web":{"enabled":false}}')["web-kits"].enabled,
    true,
  );
});

test("unknown fields are preserved in raw config but ignored in resolved config", () => {
  const input = {
    future: { enabled: false },
    notify: { unknown: true },
    workspace: { future: false, terminal: { oldEditor: "legacy" } },
    workflow: { subagent: { mux: { backend: "old" } } },
    subagent: {
      unknown: null,
      extensionAllowlist: [
        { source: "package", extensions: ["pi-web-kits"], unknown: true },
      ],
    },
    "web-kits": { fetch: { github: { future: ["anything"] } } },
  };
  const raw = parsePiKitsFile(JSON.stringify(input));
  assert.deepEqual(raw, input);
  const config = resolvePiKitsConfig(raw);
  assert.deepEqual(
    config,
    resolvePiKitsConfig({
      subagent: {
        extensionAllowlist: [
          { source: "package", extensions: ["pi-web-kits"] },
        ],
      },
    }),
  );
});

test("obsolete GitHub settings remain raw but are ignored, including invalid types", () => {
  for (const enabled of [true, false]) {
    const input = {
      "web-kits": {
        fetch: {
          github: {
            enabled,
            mode: { invalid: true },
            maxRepoSizeMB: "invalid",
            cloneTimeoutSeconds: null,
            clonePath: 42,
          },
        },
      },
    };
    const raw = parsePiKitsFile(JSON.stringify(input));
    assert.deepEqual(raw, input);
    assert.deepEqual(resolvePiKitsConfig(raw)["web-kits"].fetch.github, {
      enabled,
    });
  }
});

test("flat configuration independently controls extensions", () => {
  const config = parsePiKitsConfig(
    JSON.stringify({
      terminal: { enabled: false, editor: "vim" },
      contextPreview: { enabled: false },
      providerUsage: { intervalMs: 2_000 },
      stats: { enabled: false },
      askUserQuestion: { enabled: false },
      subagent: { maxConcurrent: 2, extensionAllowlist: [] },
      commit: { timeoutMs: 5_000, rememberModel: false },
      notify: { quietPeriodMs: 0 },
    }),
  );
  assert.equal(config.terminal.enabled, false);
  assert.equal(config.terminal.editor, "vim");
  assert.equal(config.open.enabled, true);
  assert.equal(config.contextPreview.enabled, false);
  assert.equal(config.providerUsage.intervalMs, 2_000);
  assert.equal(config.stats.enabled, false);
  assert.equal(config.askUserQuestion.enabled, false);
  assert.equal(config.subagent.enabled, true);
  assert.equal(config.subagent.maxConcurrent, 2);
  assert.deepEqual(config.subagent.extensionAllowlist, []);
  assert.equal(config.commit.timeoutMs, 5_000);
  assert.equal(config.commit.rememberModel, false);
  assert.equal(config.notify.quietPeriodMs, 0);
  assert.ok(!("workspace" in config));
  assert.ok(!("usage" in config));
  assert.ok(!("workflow" in config));
});

test("flat fields override legacy fields without losing group disable semantics", () => {
  const config = parsePiKitsConfig(
    JSON.stringify({
      workspace: {
        enabled: false,
        terminal: { editor: "vim", gitUI: "gitui", enabled: true },
      },
      terminal: { enabled: true, editor: "hx" },
      usage: { enabled: false, providerUsage: { intervalMs: 3_000 } },
      providerUsage: { timeoutMs: 500 },
      workflow: {
        enabled: false,
        subagent: { maxConcurrent: 2 },
        commit: { model: "p/old", rememberModel: false },
      },
      subagent: { enabled: true },
      commit: { lastModel: "p/new" },
    }),
  );
  assert.equal(config.terminal.enabled, true);
  assert.equal(config.terminal.editor, "hx");
  assert.equal(config.terminal.gitUI, "gitui");
  assert.equal(config.open.enabled, false);
  assert.equal(config.providerUsage.enabled, false);
  assert.equal(config.providerUsage.intervalMs, 3_000);
  assert.equal(config.providerUsage.timeoutMs, 500);
  assert.equal(config.stats.enabled, false);
  assert.equal(config.subagent.enabled, true);
  assert.equal(config.subagent.maxConcurrent, 2);
  assert.equal(config.commit.enabled, false);
  assert.equal(config.commit.model, "p/old");
  assert.equal(config.commit.lastModel, "p/new");
  assert.equal(config.commit.rememberModel, false);
  assert.equal(config.notify.enabled, false);
});

for (const value of [
  '{"terminal":{"editor":" "}}',
  '{"stats":{"enabled":"false"}}',
  '{"providerUsage":{"intervalMs":0}}',
  '{"commit":{"timeoutMs":0}}',
]) {
  test(`invalid flat config is rejected: ${value}`, () => {
    assert.throws(() => parsePiKitsConfig(value), /Invalid pi-kits.json/);
  });
}

test("partial config preserves explicit false and zero", () => {
  const config = parsePiKitsConfig(
    JSON.stringify({
      workspace: {
        terminal: { editor: "vim" },
        contextPreview: { enabled: false },
      },
      usage: { enabled: false },
      workflow: {
        notify: { quietPeriodMs: 0 },
        commit: { rememberModel: false },
      },
      "web-kits": { search: { enabled: false } },
    }),
  );
  assert.equal(config.terminal.enabled, true);
  assert.equal(config.contextPreview.enabled, false);
  assert.equal(config.terminal.editor, "vim");
  assert.equal(config.stats.enabled, false);
  assert.equal(config.commit.rememberModel, false);
  assert.equal(config.notify.quietPeriodMs, 0);
  assert.equal(config["web-kits"].search.enabled, false);
  assert.equal(config["web-kits"].fetch.enabled, true);
});

test("subagent settings default to enabled without mux configuration", () => {
  for (const raw of [
    {},
    { subagent: {} },
    { subagent: { enabled: true } },
    { workflow: { subagent: {} } },
    { workflow: { subagent: { enabled: true } } },
  ]) {
    assert.deepEqual(parsePiKitsConfig(JSON.stringify(raw)).subagent, {
      enabled: true,
      maxConcurrent: 4,
      extensionAllowlist: [...SUBAGENT_DEFAULT_EXTENSIONS],
    });
  }
  for (const maxConcurrent of [1, 32]) {
    for (const raw of [
      { subagent: { enabled: false, maxConcurrent } },
      { workflow: { subagent: { enabled: false, maxConcurrent } } },
    ]) {
      assert.deepEqual(parsePiKitsConfig(JSON.stringify(raw)).subagent, {
        enabled: false,
        maxConcurrent,
        extensionAllowlist: [...SUBAGENT_DEFAULT_EXTENSIONS],
      });
    }
  }
});

test("thinking is forwarded without maintaining Pi's level vocabulary", () => {
  const config = parsePiKitsConfig(
    '{"workflow":{"commit":{"thinking":"future-level"}}}',
  );
  assert.equal(config.commit.thinking, "future-level");
});

test("explicit subagent extension allowlists replace defaults, including empty", () => {
  for (const extensionAllowlist of [
    [],
    ["builtin:mcp", "/trusted/custom.ts"],
    ["npm:@narumitw/pi-chrome-devtools", "git:github.com/example/tools"],
    [{ source: "git:github.com/aqua2k1/pi-kits", extensions: ["pi-web-kits"] }],
    [{ source: "package", extensions: [] }],
  ]) {
    const config = parsePiKitsConfig(
      JSON.stringify({
        workflow: { subagent: { extensionAllowlist } },
      }),
    );
    assert.deepEqual(config.subagent.extensionAllowlist, extensionAllowlist);
    assert.notEqual(config.subagent.extensionAllowlist, extensionAllowlist);
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
  ]) {
    assert.throws(
      () =>
        parsePiKitsConfig(
          JSON.stringify({
            workflow: { subagent: { extensionAllowlist } },
          }),
        ),
      /Invalid pi-kits.json/,
    );
  }
});

test("package selection arrays are isolated from parsed file configuration", () => {
  const raw = parsePiKitsFile(
    '{"workflow":{"subagent":{"extensionAllowlist":[{"source":"package","extensions":["pi-web-kits"]}]}}}',
  );
  const config = resolvePiKitsConfig(raw);
  const selected = config.subagent.extensionAllowlist[0];
  assert.ok(typeof selected !== "string");
  selected.extensions.length = 0;
  assert.deepEqual(raw.workflow?.subagent?.extensionAllowlist, [
    { source: "package", extensions: ["pi-web-kits"] },
  ]);
});

test("fresh snapshots pick up edits without retaining mutable defaults", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-kits-config-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(getPiKitsConfigPath(dir), '{"usage":{"enabled":false}}');
  const first = readPiKitsConfig(dir);
  first.terminal.enabled = false;
  first.subagent.extensionAllowlist.length = 0;
  writeFileSync(getPiKitsConfigPath(dir), "{}");
  const second = readPiKitsConfig(dir);
  assert.equal(second.stats.enabled, true);
  assert.equal(second.terminal.enabled, true);
  assert.deepEqual(
    second.subagent.extensionAllowlist,
    SUBAGENT_DEFAULT_EXTENSIONS,
  );
});

for (const [name, value] of [
  ["non-object", "null"],
  ["malformed JSON", "{"],
  ["invalid enable type", '{"workspace":{"enabled":"false"}}'],
  ["empty executable", '{"workspace":{"terminal":{"editor":" "}}}'],
  [
    "overflow interval",
    '{"usage":{"providerUsage":{"intervalMs":2147483648}}}',
  ],
  ["invalid timeout", '{"workflow":{"commit":{"timeoutMs":0}}}'],
  ["invalid thinking type", '{"workflow":{"commit":{"thinking":false}}}'],
  ["invalid subagent enabled", '{"workflow":{"subagent":{"enabled":"true"}}}'],
  ["zero concurrency", '{"workflow":{"subagent":{"maxConcurrent":0}}}'],
  ["overflow concurrency", '{"workflow":{"subagent":{"maxConcurrent":33}}}'],
  ["fractional concurrency", '{"workflow":{"subagent":{"maxConcurrent":1.5}}}'],
  ["string concurrency", '{"workflow":{"subagent":{"maxConcurrent":"4"}}}'],
  [
    "unknown provider",
    '{"web-kits":{"search":{"routing":{"provider":"invalid"}}}}',
  ],
  ["invalid results", '{"web-kits":{"search":{"maxResults":11}}}'],
  [
    "alias fallback conflict",
    '{"web-kits":{"search":{"routing":{"provider":"codex","fallbackProvider":"codex-alpha-search"}}}}',
  ],
  [
    "default fallback conflict",
    '{"web-kits":{"search":{"routing":{"fallbackProvider":"searxng"}}}}',
  ],
  [
    "invalid Codex model",
    '{"web-kits":{"search":{"codex":{"model":"bad model"}}}}',
  ],
] as const) {
  test(`invalid config is rejected: ${name}`, () => {
    assert.throws(() => parsePiKitsConfig(value), /Invalid pi-kits.json/);
  });
}

test("invalid and unreadable config files never fall back to defaults", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-kits-config-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(getPiKitsConfigPath(dir), "null");
  assert.throws(() => readPiKitsConfig(dir), /Invalid pi-kits.json/);
  rmSync(getPiKitsConfigPath(dir));
  mkdirSync(getPiKitsConfigPath(dir));
  assert.throws(() => readPiKitsConfig(dir), /Could not read/);
});

test("agent directory override and home expansion match Pi", (t) => {
  const before = process.env.PI_CODING_AGENT_DIR;
  t.after(() => {
    if (before === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = before;
  });
  process.env.PI_CODING_AGENT_DIR = "/tmp/pi-kits-custom-agent";
  assert.equal(getPiKitsConfigPath(), "/tmp/pi-kits-custom-agent/pi-kits.json");
  process.env.PI_CODING_AGENT_DIR = "~/pi-kits-custom-agent";
  assert.ok(!getAgentDir().includes("~"));
});

test("configuration updates preserve sections and reject invalid writes", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-kits-update-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(
    getPiKitsConfigPath(dir),
    '{"usage":{"enabled":false,"future":1},"future":{"value":true}}',
  );
  updatePiKitsConfig(
    (raw) => ({
      ...raw,
      workflow: { commit: { lastModel: "provider/model" } },
    }),
    dir,
  );
  assert.equal(readPiKitsConfig(dir).stats.enabled, false);
  assert.equal(readPiKitsConfig(dir).commit.lastModel, "provider/model");
  assert.deepEqual(JSON.parse(readFileSync(getPiKitsConfigPath(dir), "utf8")), {
    usage: { enabled: false, future: 1 },
    future: { value: true },
    workflow: { commit: { lastModel: "provider/model" } },
  });
  const before = readFileSync(getPiKitsConfigPath(dir), "utf8");
  assert.throws(
    () =>
      updatePiKitsConfig(
        (raw) => ({
          ...raw,
          workflow: { commit: { lastModel: "" } },
        }),
        dir,
      ),
    /Invalid pi-kits.json/,
  );
  assert.equal(readFileSync(getPiKitsConfigPath(dir), "utf8"), before);
});

test("published JSON schema and example match runtime validation", () => {
  assert.deepEqual(
    JSON.parse(
      readFileSync(
        new URL("../../pi-kits.schema.json", import.meta.url),
        "utf8",
      ),
    ),
    JSON.parse(JSON.stringify(PI_KITS_SCHEMA)),
  );
  const rawExample = parsePiKitsFile(
    readFileSync(
      new URL("../../pi-kits.example.json", import.meta.url),
      "utf8",
    ),
  );
  for (const archived of [
    "contextPreview",
    "providerUsage",
    "stats",
    "commit",
    "notify",
  ]) {
    assert.equal(Object.hasOwn(rawExample, archived), false, archived);
  }
  // The preview extension still uses the editor setting after terminal archival.
  assert.deepEqual(rawExample.terminal, { editor: "nvim" });
  const example = resolvePiKitsConfig(rawExample);
  assert.deepEqual(example.subagent, {
    enabled: true,
    maxConcurrent: 4,
    extensionAllowlist: [
      ...SUBAGENT_DEFAULT_EXTENSIONS,
      { source: "git:github.com/aqua2k1/pi-kits", extensions: [] },
    ],
  });
});
