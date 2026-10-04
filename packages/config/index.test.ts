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
  readPiKitsConfig,
  readPiKitsFile,
  SUBAGENT_DEFAULT_EXTENSIONS,
  updatePiKitsConfig,
} from "./index.ts";

test("absent config uses defaults without creating a file", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-kits-config-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.equal(readPiKitsFile(dir), undefined);
  const config = readPiKitsConfig(dir);
  assert.equal(config.workspace.terminal.editor, "nvim");
  assert.equal(config.workspace.terminal.gitUI, "lazygit");
  assert.equal(config.workspace.terminal.fileManager, "yazi");
  assert.equal(config.usage.providerUsage.intervalMs, 600_000);
  assert.equal(config.usage.providerUsage.timeoutMs, 15_000);
  assert.equal(config.workflow.commit.timeoutMs, 120_000);
  assert.equal(config.workflow.commit.rememberModel, true);
  assert.equal(config.workflow.notify.quietPeriodMs, 1_000);
  assert.deepEqual(config.workflow.subagent, {
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
  assert.equal(config.workspace.enabled, true);
  assert.equal(config.workspace.contextPreview.enabled, false);
  assert.equal(config.workspace.terminal.editor, "vim");
  assert.equal(config.usage.enabled, false);
  assert.equal(config.workflow.commit.rememberModel, false);
  assert.equal(config.workflow.notify.quietPeriodMs, 0);
  assert.equal(config.web.search.enabled, false);
  assert.equal(config.web.fetch.enabled, true);
});

test("subagent settings require explicit mux and preserve defaults", () => {
  for (const subagent of [{}, { enabled: true }]) {
    assert.deepEqual(
      parsePiKitsConfig(JSON.stringify({ workflow: { subagent } })).workflow
        .subagent,
      {
        enabled: true,
        mux: undefined,
        maxConcurrent: 4,
        extensionAllowlist: [...SUBAGENT_DEFAULT_EXTENSIONS],
      },
    );
  }
  assert.deepEqual(
    parsePiKitsConfig('{"workflow":{"subagent":{"mux":"herdr"}}}').workflow
      .subagent,
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
    assert.deepEqual(config.workflow.subagent, {
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
  assert.equal(config.workflow.commit.thinking, "future-level");
});

test("explicit subagent extension allowlists replace defaults, including empty", () => {
  for (const extensionAllowlist of [
    [],
    ["builtin:mcp", "/trusted/custom.ts"],
    ["npm:@narumitw/pi-chrome-devtools", "git:github.com/example/tools"],
  ]) {
    const config = parsePiKitsConfig(
      JSON.stringify({
        workflow: { subagent: { extensionAllowlist } },
      }),
    );
    assert.deepEqual(
      config.workflow.subagent.extensionAllowlist,
      extensionAllowlist,
    );
    assert.notEqual(
      config.workflow.subagent.extensionAllowlist,
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

test("fresh snapshots pick up edits without retaining mutable defaults", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-kits-config-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(getPiKitsConfigPath(dir), '{"usage":{"enabled":false}}');
  const first = readPiKitsConfig(dir);
  first.workspace.enabled = false;
  first.workflow.subagent.extensionAllowlist.length = 0;
  writeFileSync(getPiKitsConfigPath(dir), "{}");
  const second = readPiKitsConfig(dir);
  assert.equal(second.usage.enabled, true);
  assert.equal(second.workspace.enabled, true);
  assert.deepEqual(
    second.workflow.subagent.extensionAllowlist,
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
  assert.equal(readPiKitsConfig(dir).usage.enabled, false);
  assert.equal(
    readPiKitsConfig(dir).workflow.commit.lastModel,
    "provider/model",
  );
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
  assert.deepEqual(example.workflow.subagent, {
    enabled: true,
    mux: "herdr",
    maxConcurrent: 4,
    extensionAllowlist: [...SUBAGENT_DEFAULT_EXTENSIONS],
  });
});
