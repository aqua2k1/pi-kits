import assert from "node:assert/strict";
import test from "node:test";
import type { RuntimeCommand, RuntimeOptions } from "../index.ts";
import {
  codexConfig,
  codexNativeArgs,
  parseCodexConfig,
  parseCodexTask,
} from "./config.ts";

const normal: RuntimeOptions = { id: "test", cwd: "/tmp" };
const review: RuntimeOptions = {
  ...normal,
  runtimeConfig: { runtime_args: ["review"] },
};
const task = (target: unknown, prompt = ""): RuntimeCommand => ({
  type: "task",
  prompt,
  runtimeParams: { review_target: target },
});

test("Codex config normalizes CSV/arrays without mutation and is idempotent", () => {
  for (const raw of [
    " review, search,review ",
    ["review", " search", "review"],
  ]) {
    const config = { runtime_args: raw };
    const before = structuredClone(config);
    const parsed = parseCodexConfig(config);
    assert.deepEqual(parsed, { runtime_args: ["review", "search"] });
    assert.deepEqual(parseCodexConfig(parsed), parsed);
    assert.deepEqual(config, before);
  }
  for (const config of [{}, { runtime_args: [] }])
    assert.deepEqual(parseCodexConfig(config), { runtime_args: [] });
});

test("Codex native switch names are not whitelisted and values stay single arguments", () => {
  for (const raw of [
    "review,search, exec ,--enable=feature,-v,exec",
    ["review", "search", "exec", "--enable=feature", "-v", "exec"],
  ]) {
    const parsed = parseCodexConfig({ runtime_args: raw });
    assert.deepEqual(parsed.runtime_args, [
      "review",
      "search",
      "exec",
      "--enable=feature",
      "-v",
    ]);
    assert.deepEqual(parseCodexConfig(parsed), parsed);
    assert.deepEqual(codexNativeArgs(parsed), [
      "--exec",
      "--enable=feature",
      "-v",
    ]);
  }
  assert.deepEqual(
    codexNativeArgs(
      parseCodexConfig({
        runtime_args: ["--unknown", "--config=label=hello world;$(echo nope)"],
      }),
    ),
    ["--unknown", "--config=label=hello world;$(echo nope)"],
  );
});

test("Codex rejects malformed, empty and control-character runtime_args", () => {
  for (const raw of [
    "",
    " ",
    "review,",
    "review,,search",
    ["search", ""],
    ["\tsearch"],
    ["--enable=fea\nture"],
    ["--unknown\u0000"],
    ["--unknown\u007f"],
    ["--unknown\u0085"],
  ])
    assert.throws(
      () => parseCodexConfig({ runtime_args: raw }),
      /nonempty.*control characters/,
    );
  for (const raw of [null, true, 12, {}, ["review", false]])
    assert.throws(
      () => parseCodexConfig({ runtime_args: raw }),
      /runtime_args/,
    );
  assert.throws(
    () => parseCodexConfig({ typo: "search" }),
    /Unsupported.*config field/,
  );
});

test("normalized runtime config takes precedence over raw agent config", () => {
  const options: RuntimeOptions = {
    ...normal,
    agent: {
      name: "test",
      description: "test",
      systemPrompt: "",
      enabled: true,
      source: "project",
      sourcePath: "/fake",
      runtimeConfig: { runtime_args: "review,search" },
    },
  };
  assert.deepEqual(codexConfig(options), {
    runtime_args: ["review", "search"],
  });
  assert.deepEqual(
    codexConfig({ ...options, runtimeConfig: { runtime_args: [] } }),
    { runtime_args: [] },
  );
});

test("normal Codex requires a prompt and rejects review_target and unknown parameters", () => {
  const command: RuntimeCommand = { type: "task", prompt: "work" };
  assert.equal(parseCodexTask(command, normal), command);
  for (const prompt of ["", "  "])
    assert.throws(
      () => parseCodexTask({ ...command, prompt }, normal),
      /nonempty/,
    );
  assert.throws(
    () => parseCodexTask(task({ type: "uncommittedChanges" }, "work"), normal),
    /requires runtime_args: review/,
  );
  assert.throws(
    () => parseCodexTask({ ...command, runtimeParams: { typo: true } }, normal),
    /Unsupported.*runtimeParams/,
  );
});

test("review requires a fresh, valid target on every task; structured targets reject prompts", () => {
  assert.throws(
    () => parseCodexTask({ type: "task", prompt: "" }, review),
    /every task/,
  );
  for (const target of [
    { type: "uncommittedChanges" },
    { type: "baseBranch", branch: "main" },
    { type: "commit", sha: "abc", title: null },
    { type: "commit", sha: "abc", title: "Subject" },
  ]) {
    const parsed = parseCodexTask(task(target), review);
    assert.deepEqual(parsed, task(target));
    assert.deepEqual(parseCodexTask(parsed, review), parsed);
    assert.throws(
      () => parseCodexTask(task(target, "extra instructions"), review),
      /cannot carry a prompt; omit prompt/,
    );
  }
  assert.deepEqual(
    parseCodexTask(task({ type: "commit", sha: "abc" }), review),
    task({ type: "commit", sha: "abc", title: null }),
  );
  for (const target of [
    null,
    [],
    {},
    { type: "other" },
    { type: "baseBranch", branch: " " },
    { type: "commit", sha: 1 },
    { type: "commit", sha: "abc", title: 2 },
    { type: "custom", instructions: " " },
    { type: "uncommittedChanges", branch: "main" },
    { type: "custom", instructions: "review", typo: true },
  ])
    assert.throws(() => parseCodexTask(task(target), review), /Codex/);
});

test("custom review consumes prompt once without mutating caller inputs", () => {
  const command = {
    ...task(
      { type: "custom", instructions: "Check correctness" },
      "Focus on security",
    ),
    round: 2,
  };
  const before = structuredClone(command);
  const parsed = parseCodexTask(command, review);
  assert.deepEqual(parsed, {
    ...command,
    prompt: "",
    runtimeParams: {
      review_target: {
        type: "custom",
        instructions: "Check correctness\n\nFocus on security",
      },
    },
  });
  assert.deepEqual(parseCodexTask(parsed, review), parsed);
  assert.deepEqual(command, before);
  assert.deepEqual(
    parseCodexTask(
      task({ type: "custom", instructions: "Check correctness" }),
      review,
    ),
    task({ type: "custom", instructions: "Check correctness" }),
  );
});

test("Codex enforces effective prompt/target size before dispatch", () => {
  assert.throws(
    () => parseCodexTask({ type: "task", prompt: "x".repeat(65537) }, normal),
    /64 KiB/,
  );
  assert.throws(
    () =>
      parseCodexTask(
        task(
          { type: "custom", instructions: "x".repeat(40000) },
          "y".repeat(40000),
        ),
        review,
      ),
    /64 KiB/,
  );
  assert.throws(
    () =>
      parseCodexTask(
        task({ type: "commit", sha: "abc", title: "x".repeat(65537) }),
        review,
      ),
    /64 KiB/,
  );
});

test("steer/cancel remain unchanged in both modes", () => {
  for (const options of [normal, review])
    for (const command of [
      { type: "steer", message: "adjust", round: 1 },
      { type: "cancel", round: 1 },
    ] as RuntimeCommand[])
      assert.equal(parseCodexTask(command, options), command);
});
