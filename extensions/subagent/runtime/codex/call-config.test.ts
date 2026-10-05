import assert from "node:assert/strict";
import test from "node:test";
import { CodexRuntime } from "./index.ts";

const runtime = new CodexRuntime();
const target = { type: "uncommittedChanges" };
const session = { runtime_args: ["review", "search"] };
const options = { id: "test", cwd: "/tmp" };

test("Codex spawn splits static switches and call-only task params without mutation", () => {
  const config = {
    runtime_args: " review, search,review ",
    review_target: target,
  };
  const before = structuredClone(config);
  const parsed = runtime.parseCallConfig(config, {}, "spawn");
  assert.deepEqual(parsed, {
    runtimeConfig: session,
    runtimeParams: { review_target: target },
  });
  assert.deepEqual(config, before);
  assert.deepEqual(runtime.parseCallConfig({}, {}, "spawn"), {
    runtimeConfig: { runtime_args: [] },
    runtimeParams: {},
  });
  assert.deepEqual(
    runtime.parseTask(
      { type: "task", prompt: "", runtimeParams: parsed.runtimeParams },
      { ...options, runtimeConfig: parsed.runtimeConfig },
    ),
    { type: "task", prompt: "", runtimeParams: { review_target: target } },
  );
});

test("Codex spawn gives agent/session static keys precedence over call keys", () => {
  for (const runtime_args of [" review,search,review ", ["review", "search"]]) {
    const config = { runtime_args };
    const before = structuredClone(config);
    assert.deepEqual(
      runtime.parseCallConfig(
        { runtime_args: "exec", review_target: target },
        config,
        "spawn",
      ),
      { runtimeConfig: session, runtimeParams: { review_target: target } },
    );
    assert.deepEqual(config, before);
  }
  assert.deepEqual(
    runtime.parseCallConfig(
      { runtime_args: "review" },
      { runtime_args: [] },
      "spawn",
    ),
    { runtimeConfig: { runtime_args: [] }, runtimeParams: {} },
  );
});

test("Codex resume accepts omitted or identically normalized static keys", () => {
  for (const config of [
    {},
    { runtime_args: " review, search,review " },
    { runtime_args: ["review", " search", "review"] },
  ]) {
    const before = structuredClone(config);
    assert.deepEqual(runtime.parseCallConfig(config, session, "resume"), {
      runtimeConfig: session,
      runtimeParams: {},
    });
    assert.deepEqual(config, before);
  }
  assert.deepEqual(
    runtime.parseCallConfig({ runtime_args: [] }, {}, "resume"),
    { runtimeConfig: { runtime_args: [] }, runtimeParams: {} },
  );
});

test("Codex resume rejects static reconfiguration before dispatch", () => {
  for (const runtime_args of [
    [],
    undefined,
    "review",
    "search,review",
    "review,search,exec",
  ])
    assert.throws(
      () =>
        runtime.parseCallConfig(
          { runtime_args, review_target: target },
          session,
          "resume",
        ),
      /cannot reconfigure session runtime_args/,
    );
  assert.throws(
    () => runtime.parseCallConfig({ runtime_args: "review" }, {}, "resume"),
    /cannot reconfigure session runtime_args/,
  );
});

test("Codex targets are fresh per call and cannot be inherited from session config", () => {
  const spawned = runtime.parseCallConfig(
    { review_target: target },
    session,
    "spawn",
  );
  const resumed = runtime.parseCallConfig({}, spawned.runtimeConfig, "resume");
  assert.deepEqual(resumed.runtimeParams, {});
  assert.throws(
    () =>
      runtime.parseTask(
        { type: "task", prompt: "", runtimeParams: resumed.runtimeParams },
        { ...options, runtimeConfig: resumed.runtimeConfig },
      ),
    /review_target on every task/,
  );
  const next = { type: "baseBranch", branch: "main" };
  assert.deepEqual(
    runtime.parseCallConfig(
      { review_target: next },
      spawned.runtimeConfig,
      "resume",
    ).runtimeParams,
    { review_target: next },
  );
  for (const phase of ["spawn", "resume"] as const) {
    assert.deepEqual(
      runtime.parseCallConfig({}, session, phase).runtimeParams,
      {},
    );
    for (const review_target of [target, null, false, [], { type: "other" }]) {
      const sessionConfig = { ...session, review_target };
      const before = structuredClone(sessionConfig);
      assert.deepEqual(runtime.parseCallConfig({}, sessionConfig, phase), {
        runtimeConfig: session,
        runtimeParams: {},
      });
      assert.deepEqual(
        runtime.parseCallConfig({ review_target: next }, sessionConfig, phase),
        { runtimeConfig: session, runtimeParams: { review_target: next } },
      );
      assert.deepEqual(runtime.parseConfig(sessionConfig), session);
      assert.deepEqual(sessionConfig, before);
    }
  }
});

test("Codex call config rejects malformed owned switches and nonobjects", () => {
  for (const phase of ["spawn", "resume"] as const) {
    for (const runtime_args of [
      null,
      true,
      12,
      {},
      ["review", false],
      "",
      "review,",
      ["\tsearch"],
    ])
      assert.throws(
        () => runtime.parseCallConfig({ runtime_args }, {}, phase),
        /Codex runtime_args/,
      );
    for (const config of [null, [], "review"])
      assert.throws(
        () =>
          runtime.parseCallConfig(
            config as unknown as Record<string, unknown>,
            session,
            phase,
          ),
        /Codex call config must be an object/,
      );
  }
});

test("Codex call config ignores foreign fields including on resume", () => {
  for (const phase of ["spawn", "resume"] as const)
    for (const field of [
      "typo",
      "prompt_mode",
      "tools",
      "disallowed_tools",
      "runtimeParams",
    ])
      for (const value of [null, false, 12, [], {}, "malformed"]) {
        const config = { [field]: value };
        const before = structuredClone(config);
        assert.deepEqual(runtime.parseCallConfig(config, session, phase), {
          runtimeConfig: session,
          runtimeParams: {},
        });
        assert.deepEqual(
          runtime.parseCallConfig(
            { ...config, review_target: target },
            session,
            phase,
          ),
          { runtimeConfig: session, runtimeParams: { review_target: target } },
        );
        assert.deepEqual(
          runtime.parseCallConfig(
            { review_target: target },
            { ...session, ...config },
            phase,
          ),
          { runtimeConfig: session, runtimeParams: { review_target: target } },
        );
        assert.deepEqual(config, before);
      }
});

test("Codex call splitting leaves review target validation and custom prompt consumption to parseTask", () => {
  for (const review_target of [
    null,
    {},
    { type: "baseBranch", branch: " " },
    { type: "custom", instructions: " " },
  ]) {
    const parsed = runtime.parseCallConfig({ review_target }, session, "spawn");
    assert.deepEqual(parsed.runtimeParams, { review_target });
    assert.throws(
      () =>
        runtime.parseTask(
          { type: "task", prompt: "", runtimeParams: parsed.runtimeParams },
          { ...options, runtimeConfig: parsed.runtimeConfig },
        ),
      /Codex/,
    );
  }
  const parsed = runtime.parseCallConfig(
    { review_target: { type: "custom", instructions: "Review" } },
    session,
    "resume",
  );
  assert.deepEqual(
    runtime.parseTask(
      {
        type: "task",
        prompt: "Check security",
        runtimeParams: parsed.runtimeParams,
      },
      { ...options, runtimeConfig: parsed.runtimeConfig },
    ),
    {
      type: "task",
      prompt: "",
      runtimeParams: {
        review_target: {
          type: "custom",
          instructions: "Review\n\nCheck security",
        },
      },
    },
  );
  const normal = runtime.parseCallConfig(
    { review_target: target },
    {},
    "spawn",
  );
  assert.throws(
    () =>
      runtime.parseTask(
        { type: "task", prompt: "Work", runtimeParams: normal.runtimeParams },
        { ...options, runtimeConfig: normal.runtimeConfig },
      ),
    /requires runtime_args: review/,
  );
});
