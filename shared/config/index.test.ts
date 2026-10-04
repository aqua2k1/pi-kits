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
    mux: undefined,
    maxConcurrent: 4,
    extensionAllowlist: [...SUBAGENT_DEFAULT_EXTENSIONS],
  });
  assert.equal(config.web.search.enabled, true);
  assert.equal(config.web.search.routing.provider, "searxng");
  assert.equal(config.web.search.timeoutMs, 15_000);
  assert.equal(config.web.search.maxResults, 5);
  assert.equal(config.web.search.codex.model, "gpt-5.4");
  assert.equal(config.web.fetch.timeoutMs, 15_000);
  assert.equal(config.web.fetch.github.mode, "auto");
  assert.equal(config.web.fetch.github.maxRepoSizeMB, 350);
  assert.equal(readPiKitsFile(dir), undefined);
});

test("flat configuration independently controls extensions", () => {
  const config = parsePiKitsConfig(
    JSON.stringify({
      terminal: { enabled: false, editor: "vim" },
      contextPreview: { enabled: false },
      providerUsage: { intervalMs: 2_000 },
      stats: { enabled: false },
      askUserQuestion: { enabled: false },
      subagent: { mux: "herdr", maxConcurrent: 2, extensionAllowlist: [] },
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
  assert.equal(config.subagent.mux, "herdr");
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
        subagent: { mux: "herdr" },
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
  assert.equal(config.subagent.mux, "herdr");
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
  '{"subagent":{"mux":"tmux"}}',
  '{"commit":{"timeoutMs":0}}',
  '{"notify":{"unknown":true}}',
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
      web: { search: { enabled: false } },
    }),
  );
  assert.equal(config.terminal.enabled, true);
  assert.equal(config.contextPreview.enabled, false);
  assert.equal(config.terminal.editor, "vim");
  assert.equal(config.stats.enabled, false);
  assert.equal(config.commit.rememberModel, false);
  assert.equal(config.notify.quietPeriodMs, 0);
  assert.equal(config.web.search.enabled, false);
  assert.equal(config.web.fetch.enabled, true);
});

test("subagent settings require explicit mux and preserve defaults", () => {
  for (const subagent of [{}, { enabled: true }]) {
    assert.deepEqual(
      parsePiKitsConfig(JSON.stringify({ workflow: { subagent } })).subagent,
      {
        enabled: true,
        mux: undefined,
        maxConcurrent: 4,
        extensionAllowlist: [...SUBAGENT_DEFAULT_EXTENSIONS],
      },
    );
  }
  assert.deepEqual(
    parsePiKitsConfig('{"workflow":{"subagent":{"mux":"herdr"}}}').subagent,
    {
      enabled: true,
      mux: "herdr",
      maxConcurrent: 4,
      extensionAllowlist: [...SUBAGENT_DEFAULT_EXTENSIONS],
    },
  );
  for (const maxConcurrent of [1, 32]) {
    const config = parsePiKitsConfig(
      JSON.stringify({
        workflow: {
          subagent: { enabled: false, mux: "herdr", maxConcurrent },
        },
      }),
    );
    assert.deepEqual(config.subagent, {
      enabled: false,
      mux: "herdr",
      maxConcurrent,
      extensionAllowlist: [...SUBAGENT_DEFAULT_EXTENSIONS],
    });
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
    [{ source: "git:github.com/aqua2k1/pi-kits", extensions: ["web-kit"] }],
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
    [{ source: "x", extensions: ["web-kit", "web-kit"] }],
    [{ source: "x", extensions: ["web-kit"], unknown: true }],
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
    '{"workflow":{"subagent":{"extensionAllowlist":[{"source":"package","extensions":["web-kit"]}]}}}',
  );
  const config = resolvePiKitsConfig(raw);
  const selected = config.subagent.extensionAllowlist[0];
  assert.ok(typeof selected !== "string");
  selected.extensions.length = 0;
  assert.deepEqual(raw.workflow?.subagent?.extensionAllowlist, [
    { source: "package", extensions: ["web-kit"] },
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
  ["unknown section", '{"usgae":{}}'],
  ["invalid enable type", '{"workspace":{"enabled":"false"}}'],
  ["empty executable", '{"workspace":{"terminal":{"editor":" "}}}'],
  [
    "overflow interval",
    '{"usage":{"providerUsage":{"intervalMs":2147483648}}}',
  ],
  ["invalid timeout", '{"workflow":{"commit":{"timeoutMs":0}}}'],
  ["invalid thinking type", '{"workflow":{"commit":{"thinking":false}}}'],
  ["unsupported mux", '{"workflow":{"subagent":{"mux":"tmux"}}}'],
  ["null mux", '{"workflow":{"subagent":{"mux":null}}}'],
  ["invalid subagent enabled", '{"workflow":{"subagent":{"enabled":"true"}}}'],
  ["zero concurrency", '{"workflow":{"subagent":{"maxConcurrent":0}}}'],
  ["overflow concurrency", '{"workflow":{"subagent":{"maxConcurrent":33}}}'],
  ["fractional concurrency", '{"workflow":{"subagent":{"maxConcurrent":1.5}}}'],
  ["string concurrency", '{"workflow":{"subagent":{"maxConcurrent":"4"}}}'],
  ["unknown subagent field", '{"workflow":{"subagent":{"agent":"custom"}}}'],
  ["unknown provider", '{"web":{"search":{"routing":{"provider":"invalid"}}}}'],
  ["invalid results", '{"web":{"search":{"maxResults":11}}}'],
  [
    "alias fallback conflict",
    '{"web":{"search":{"routing":{"provider":"codex","fallbackProvider":"codex-alpha-search"}}}}',
  ],
  [
    "default fallback conflict",
    '{"web":{"search":{"routing":{"fallbackProvider":"searxng"}}}}',
  ],
  ["invalid Codex model", '{"web":{"search":{"codex":{"model":"bad model"}}}}'],
  ["embedded credential", '{"web":{"search":{"searxng":{"apiKey":"secret"}}}}'],
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
  writeFileSync(getPiKitsConfigPath(dir), '{"usage":{"enabled":false}}');
  updatePiKitsConfig(
    (raw) => ({
      ...raw,
      workflow: { commit: { lastModel: "provider/model" } },
    }),
    dir,
  );
  assert.equal(readPiKitsConfig(dir).stats.enabled, false);
  assert.equal(readPiKitsConfig(dir).commit.lastModel, "provider/model");
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
  const example = parsePiKitsConfig(
    readFileSync(
      new URL("../../pi-kits.example.json", import.meta.url),
      "utf8",
    ),
  );
  assert.deepEqual(example.subagent, {
    enabled: true,
    mux: "herdr",
    maxConcurrent: 4,
    extensionAllowlist: [
      ...SUBAGENT_DEFAULT_EXTENSIONS,
      { source: "git:github.com/aqua2k1/pi-kits", extensions: [] },
    ],
  });
});
