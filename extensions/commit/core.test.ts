/**
 * Unit tests for the pi-free core of the /commit extension.
 * Run: npm test (tsx --test)
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { getPiKitsConfigPath } from "@pi-kits/config";
import { useAgentDir } from "../../tests/helpers/agent-dir.ts";
import {
  buildPiArgs,
  buildTask,
  COMMIT_SYSTEM_PROMPT,
  firstLineOf,
  getAgentDir,
  getStagedDiff,
  getStagedFiles,
  gitCommit,
  lastModelPath,
  orderModelOptions,
  parseStagedOutput,
  readLastModel,
  runPiGenerate,
  stripCodeFences,
  TASK_HEADER,
  writeLastModel,
} from "./core.ts";

// ---- parseStagedOutput ------------------------------------------------------

test("parseStagedOutput: empty output → no files", () => {
  assert.deepEqual(parseStagedOutput(""), []);
  assert.deepEqual(parseStagedOutput("  \n"), []);
});

test("parseStagedOutput: status + path columns", () => {
  assert.deepEqual(parseStagedOutput("M\tsrc/foo.ts\nA\tbar/baz.ts\n"), [
    { status: "M", path: "src/foo.ts" },
    { status: "A", path: "bar/baz.ts" },
  ]);
});

test("parseStagedOutput: rename joins old and new path", () => {
  assert.deepEqual(parseStagedOutput("R100\told.ts\tnew.ts"), [
    { status: "R100", path: "old.ts → new.ts" },
  ]);
});

test("parseStagedOutput: paths with spaces survive", () => {
  assert.deepEqual(parseStagedOutput("M\tmy file.ts"), [
    { status: "M", path: "my file.ts" },
  ]);
});

// ---- git round-trip -----------------------------------------------------------

test("git: staged files → diff → commit round-trip", async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "commit-git-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  try {
    execFileSync("git", ["init", "-q"], { cwd: dir });
    writeFileSync(path.join(dir, "a.txt"), "one\n");
    execFileSync("git", ["add", "a.txt"], { cwd: dir });
    assert.deepEqual(getStagedFiles(dir), [{ status: "A", path: "a.txt" }]);
    assert.match(getStagedDiff(dir), /\+one/);

    // git commit requires an identity — set one for the duration of the call.
    const identity = {
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    };
    const saved = Object.fromEntries(
      Object.keys(identity).map((key) => [key, process.env[key]]),
    );
    Object.assign(process.env, identity);
    try {
      assert.match(gitCommit("feat: init", dir), /feat: init/);
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
    assert.deepEqual(getStagedFiles(dir), []);
  } catch (err) {
    if ((err as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      t.skip("git not available");
      return;
    }
    throw err;
  }
});

// ---- buildTask --------------------------------------------------------------

test("buildTask: lists staged files and includes the diff", () => {
  const task = buildTask(
    [
      { status: "M", path: "src/foo.ts" },
      { status: "R100", path: "old.ts → new.ts" },
    ],
    "+validated input\n-removed line",
  );
  assert.match(task, /文件列表:/);
  assert.match(task, /- M {2}src\/foo\.ts/);
  assert.match(task, /- R100 {2}old\.ts → new\.ts/);
  assert.match(task, /<staged diff>/);
  assert.match(task, /\+validated input/);
  // Single source of truth: the rules live in the system prompt, not here.
  assert.doesNotMatch(task, /Conventional|72 字符|feat/);
});

// ---- COMMIT_SYSTEM_PROMPT / buildPiArgs -------------------------------------

test("COMMIT_SYSTEM_PROMPT: carries the Conventional Commits rules", () => {
  assert.match(COMMIT_SYSTEM_PROMPT, /type\(scope\): description/);
  assert.match(
    COMMIT_SYSTEM_PROMPT,
    /feat.*fix.*chore.*docs.*style.*refactor.*test.*ci.*perf/s,
  );
  assert.match(COMMIT_SYSTEM_PROMPT, /72 characters/);
  assert.match(COMMIT_SYSTEM_PROMPT, /Output ONLY the commit message text/);
});

test("buildPiArgs: lean non-interactive pi invocation, model + header", () => {
  assert.deepEqual(buildPiArgs("opencode-go/deepseek-v4-flash"), [
    "-p",
    "--model",
    "opencode-go/deepseek-v4-flash",
    "--system-prompt",
    COMMIT_SYSTEM_PROMPT,
    "--no-tools",
    "--no-extensions",
    "--no-skills",
    "--no-context-files",
    "--no-session",
    TASK_HEADER,
  ]);
});

test("buildPiArgs: thinking flag before header when provided", () => {
  const args = buildPiArgs("p/m", "high");
  assert.deepEqual(args.slice(-3), ["--thinking", "high", TASK_HEADER]);
});

// ---- runPiGenerate ----------------------------------------------------------

const FAKE_PI_ECHO = `#!/usr/bin/env node
let data = "";
process.stdin.on("data", (c) => (data += c));
process.stdin.on("end", () => {
  process.stdout.write("feat: fake commit\\n");
});
`;

const FAKE_PI_FAIL = `#!/usr/bin/env node
process.stdin.resume();
process.stdin.on("end", () => {
  process.stdout.write("Error: Model \\"nope/x\\" not found.\\n");
  process.exit(1);
});
`;

/** Run fn with a fake `pi` executable on PATH (temp dir). */
async function withFakePi(
  script: string,
  fn: (cwd: string) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(path.join(os.tmpdir(), "commit-fake-pi-"));
  const bin = path.join(dir, "pi");
  writeFileSync(bin, script);
  chmodSync(bin, 0o755);
  const prev = process.env.PATH;
  process.env.PATH = `${dir}:${prev ?? ""}`;
  try {
    await fn(dir);
  } finally {
    if (prev === undefined) delete process.env.PATH;
    else process.env.PATH = prev;
    rmSync(dir, { recursive: true, force: true });
  }
}

test("runPiGenerate: resolves stdout, passes task on stdin", async () => {
  await withFakePi(FAKE_PI_ECHO, async (cwd) => {
    const result = await runPiGenerate({
      model: "p/m",
      task: "task payload",
      cwd,
      timeoutMs: 5_000,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.message, "feat: fake commit");
  });
});

test("runPiGenerate: non-zero exit surfaces the error text", async () => {
  await withFakePi(FAKE_PI_FAIL, async (cwd) => {
    const result = await runPiGenerate({
      model: "nope/x",
      task: "x",
      cwd,
      timeoutMs: 5_000,
    });
    assert.equal(result.message, "");
    assert.match(result.error ?? "", /Model "nope\/x" not found/);
  });
});

test("runPiGenerate: timeout kills the child and reports timeout", async () => {
  const script = `#!/usr/bin/env node
setTimeout(() => process.exit(0), 60_000);
`;
  await withFakePi(script, async (cwd) => {
    const result = await runPiGenerate({
      model: "p/m",
      task: "x",
      cwd,
      timeoutMs: 50,
    });
    assert.equal(result.message, "");
    assert.equal(result.error, "生成超时");
  });
});

// ---- stripCodeFences ---------------------------------------------------------

test("stripCodeFences: strips fenced block", () => {
  assert.equal(stripCodeFences("```text\nfeat: x\n```"), "feat: x");
  assert.equal(stripCodeFences("```\nfeat: x\n```\n"), "feat: x");
});

test("stripCodeFences: plain text untouched (trimmed)", () => {
  assert.equal(stripCodeFences("  feat: x\n\n"), "feat: x");
});

// ---- orderModelOptions --------------------------------------------------------

test("orderModelOptions: dedupes and moves first to the front", () => {
  assert.deepEqual(orderModelOptions(["b/x", "a/y", "b/x", "c/z"], "c/z"), [
    "c/z",
    "b/x",
    "a/y",
  ]);
});

test("orderModelOptions: no first → order preserved", () => {
  assert.deepEqual(orderModelOptions(["b/x", "a/y"]), ["b/x", "a/y"]);
});

test("orderModelOptions: absent first only prepends with prependIfMissing", () => {
  const labels = ["b/x", "a/y"];
  assert.deepEqual(orderModelOptions(labels, "nope/m"), ["b/x", "a/y"]);
  assert.deepEqual(orderModelOptions(labels, "nope/m", true), [
    "nope/m",
    "b/x",
    "a/y",
  ]);
});

// ---- last model memory --------------------------------------------------------

test("last model: write → read round-trip in unified configuration", (t) => {
  const dir = useAgentDir(t);
  assert.equal(lastModelPath(), getPiKitsConfigPath(dir));
  assert.equal(readLastModel(), undefined);
  writeLastModel("opencode-go/deepseek-v4-flash");
  assert.equal(readLastModel(), "opencode-go/deepseek-v4-flash");
  const raw = JSON.parse(readFileSync(lastModelPath(), "utf8"));
  assert.deepEqual(raw, {
    workflow: { commit: { lastModel: "opencode-go/deepseek-v4-flash" } },
  });
  if (process.platform !== "win32") {
    assert.equal(statSync(lastModelPath()).mode & 0o777, 0o600);
  }
  assert.equal(
    existsSync(path.join(dir, "extensions", "commit", "last_model.json")),
    false,
  );
});

test("last model: missing configuration or unset field → undefined", (t) => {
  const dir = useAgentDir(t);
  assert.equal(readLastModel(), undefined);
  for (const raw of [{}, { workflow: {} }, { workflow: { commit: {} } }]) {
    writeFileSync(getPiKitsConfigPath(dir), JSON.stringify(raw));
    assert.equal(readLastModel(), undefined);
  }
});

test("last model: invalid unified configuration throws without overwriting it", (t) => {
  const dir = useAgentDir(t);
  const target = getPiKitsConfigPath(dir);
  for (const invalid of [
    "{not json",
    '{"workflow":{"commit":{"lastModel":""}}}',
    '{"workflow":{"commit":{"lastModel":null}}}',
    '{"workflow":{"commit":{"lastModel":123}}}',
    '{"usage":{"enabled":"invalid"}}',
  ]) {
    writeFileSync(target, invalid);
    assert.throws(() => readLastModel(), /Invalid pi-kits.json/);
    assert.throws(() => writeLastModel("p/new"), /Invalid pi-kits.json/);
    assert.equal(readFileSync(target, "utf8"), invalid);
  }
});

test("last model: writes preserve other kit sections and workflow settings", (t) => {
  const raw = {
    workspace: { terminal: { editor: "vim" } },
    usage: { stats: { enabled: false } },
    web: { search: { maxResults: 3 } },
    workflow: {
      enabled: true,
      notify: { enabled: false, quietPeriodMs: 75 },
      commit: {
        model: "p/configured",
        thinking: "high",
        timeoutMs: 4_321,
        rememberModel: true,
        lastModel: "p/old",
      },
    },
  };
  const dir = useAgentDir(t, raw);
  writeLastModel("p/new", dir);
  assert.deepEqual(JSON.parse(readFileSync(lastModelPath(dir), "utf8")), {
    ...raw,
    workflow: {
      ...raw.workflow,
      commit: { ...raw.workflow.commit, lastModel: "p/new" },
    },
  });
});

test("last model: legacy state is ignored, never migrated or modified", (t) => {
  const dir = useAgentDir(t);
  const legacy = path.join(dir, "extensions", "commit", "last_model.json");
  const contents = '{"last_model":"legacy/model"}';
  mkdirSync(path.dirname(legacy), { recursive: true });
  writeFileSync(legacy, contents);
  assert.equal(readLastModel(), undefined);
  assert.equal(existsSync(lastModelPath()), false);
  writeLastModel("p/new");
  assert.equal(readLastModel(), "p/new");
  assert.equal(readFileSync(legacy, "utf8"), contents);
  writeFileSync(legacy, "{invalid legacy json");
  assert.equal(readLastModel(), "p/new");
});

// ---- getAgentDir --------------------------------------------------------------

test("getAgentDir: PI_CODING_AGENT_DIR expansion", async () => {
  const saved = process.env.PI_CODING_AGENT_DIR;
  try {
    delete process.env.PI_CODING_AGENT_DIR;
    assert.equal(getAgentDir(), path.join(os.homedir(), ".pi", "agent"));
    process.env.PI_CODING_AGENT_DIR = "~";
    assert.equal(getAgentDir(), os.homedir());
    process.env.PI_CODING_AGENT_DIR = "~/x";
    assert.equal(getAgentDir(), path.join(os.homedir(), "x"));
    process.env.PI_CODING_AGENT_DIR = "/abs";
    assert.equal(getAgentDir(), "/abs");
  } finally {
    if (saved === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = saved;
  }
});

// ---- firstLineOf --------------------------------------------------------------

test("firstLineOf: prefers stderr, else message, else String()", () => {
  assert.equal(
    firstLineOf({ stderr: Buffer.from("fatal: not a git repo\nmore") }),
    "fatal: not a git repo",
  );
  assert.equal(firstLineOf(new Error("line1\nline2")), "line1");
  assert.equal(firstLineOf("plain"), "plain");
});
