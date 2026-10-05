import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentDefinition } from "../../agents.ts";
import type { RuntimeCommand, RuntimeOptions } from "../index.ts";
import { parsePiCallConfig, parsePiConfig, parsePiTask } from "./config.ts";
import { PiRuntime } from "./index.ts";

const options: RuntimeOptions = { id: "test", cwd: "/tmp" };
const agent: AgentDefinition = {
  name: "test",
  description: "Test",
  systemPrompt: "Role",
  enabled: true,
  source: "project",
  sourcePath: "/agents/test.md",
};

test("Pi config preserves omission and normalizes only supplied fields", () => {
  assert.deepEqual(parsePiConfig({}), {});
  assert.deepEqual(
    parsePiConfig({ tools: undefined, prompt_mode: undefined }),
    {},
  );
  const raw = {
    tools: "read, bash, read, , codemode",
    disallowed_tools: [" edit ", "write", "edit", ""],
    prompt_mode: " append ",
  };
  const expected = {
    tools: ["read", "bash", "codemode"],
    disallowed_tools: ["edit", "write"],
    prompt_mode: "append",
  };
  assert.deepEqual(parsePiConfig(raw), expected);
  assert.deepEqual(parsePiConfig(expected), expected);
  assert.equal(raw.tools, "read, bash, read, , codemode");
  assert.deepEqual(raw.disallowed_tools, [" edit ", "write", "edit", ""]);
});

test("Pi tool lists support CSV/arrays, native and extension tool names", () => {
  for (const key of ["tools", "disallowed_tools"]) {
    for (const value of [
      " read, codemode, tool_search, web_search, 123tool, native/tool ",
      [
        "read",
        " codemode ",
        "tool_search",
        "web_search",
        "123tool",
        "native/tool",
      ],
    ]) {
      assert.deepEqual(parsePiConfig({ [key]: value }), {
        [key]: [
          "read",
          "codemode",
          "tool_search",
          "web_search",
          "123tool",
          "native/tool",
        ],
      });
    }
    assert.deepEqual(
      parsePiConfig({ [key]: ["read", "", "  ", "read", "bash"] }),
      {
        [key]: ["read", "bash"],
      },
    );
    for (const value of ["none", " none ", [], "", "  ", ", ,"]) {
      assert.deepEqual(parsePiConfig({ [key]: value }), { [key]: [] });
    }
    // Only the complete CSV shorthand "none" means no tools.
    assert.deepEqual(parsePiConfig({ [key]: ["none"] }), { [key]: ["none"] });
    assert.deepEqual(parsePiConfig({ [key]: "none, read" }), {
      [key]: ["none", "read"],
    });
  }
});

test("Pi rejects malformed tool lists and unsafe comma/control-character names", () => {
  for (const key of ["tools", "disallowed_tools"]) {
    for (const value of [null, false, 123, {}, [false], [123], [null], [[]]]) {
      assert.throws(
        () => parsePiConfig({ [key]: value }),
        new RegExp(`Pi ${key}`),
      );
    }
    for (const value of [
      ["a,b"],
      ["a\nb"],
      ["a\tb"],
      ["a\rb"],
      ["a\u0000b"],
      ["a\u0085b"],
      "a\nb",
    ]) {
      assert.throws(() => parsePiConfig({ [key]: value }), /invalid tool name/);
    }
  }
});

test("Pi prompt mode accepts replace/append and preserves the implicit default", () => {
  assert.equal(parsePiConfig({}).prompt_mode, undefined);
  for (const mode of ["replace", "append"] as const) {
    assert.deepEqual(parsePiConfig({ prompt_mode: mode }), {
      prompt_mode: mode,
    });
    assert.deepEqual(parsePiConfig({ prompt_mode: ` ${mode} ` }), {
      prompt_mode: mode,
    });
  }
  for (const prompt_mode of [
    "typo",
    "Replace",
    "APPEND",
    null,
    false,
    123,
    "",
    " ",
    [],
    ["append"],
    {},
  ]) {
    assert.throws(
      () => parsePiConfig({ prompt_mode }),
      /prompt_mode must be replace or append/,
    );
  }
});

test("Pi ignores and strips unowned config fields but validates the outer object", () => {
  for (const key of [
    "runtime_args",
    "future_option",
    "review_target",
    "model",
    "thinking",
    "tools_extra",
  ]) {
    for (const value of [
      undefined,
      null,
      "review, search",
      [false],
      [],
      true,
      {},
    ]) {
      assert.deepEqual(parsePiConfig({ [key]: value }), {});
      assert.deepEqual(parsePiConfig({ [key]: value, tools: "read, read" }), {
        tools: ["read"],
      });
      assert.throws(
        () => parsePiConfig({ [key]: value, tools: false }),
        /CSV string or string array/,
      );
    }
  }
  for (const value of [null, false, "tools", []]) {
    assert.throws(
      () => parsePiConfig(value as unknown as Record<string, unknown>),
      /configuration must be an object/,
    );
  }
});

test("Pi call config splits static config from empty task params and merges per key", () => {
  const runtime = new PiRuntime();
  assert.deepEqual(runtime.parseCallConfig({}, {}, "spawn"), {
    runtimeConfig: {},
    runtimeParams: {},
  });
  const call = {
    tools: "read, bash",
    disallowed_tools: "write, write",
    prompt_mode: "append",
  };
  const session = { tools: "none", prompt_mode: "replace" };
  assert.deepEqual(runtime.parseCallConfig(call, session, "spawn"), {
    runtimeConfig: {
      tools: [],
      disallowed_tools: ["write"],
      prompt_mode: "replace",
    },
    runtimeParams: {},
  });
  assert.deepEqual(
    parsePiCallConfig({ tools: "read" }, { disallowed_tools: "bash" }, "spawn"),
    {
      runtimeConfig: { tools: ["read"], disallowed_tools: ["bash"] },
      runtimeParams: {},
    },
  );
  assert.deepEqual(
    parsePiCallConfig({ tools: false }, { tools: "read" }, "spawn"),
    {
      runtimeConfig: { tools: ["read"] },
      runtimeParams: {},
    },
  );
  assert.equal(call.tools, "read, bash");
  assert.equal(session.tools, "none");
});

test("Pi resume accepts only normalized retained static values without changing omission", () => {
  const retained = {
    tools: ["read", "bash"],
    disallowed_tools: ["write"],
    prompt_mode: "append",
  };
  for (const supplied of [
    {},
    { tools: " read, bash, read " },
    { disallowed_tools: [" write ", "write"] },
    { prompt_mode: " append " },
    retained,
  ]) {
    assert.deepEqual(parsePiCallConfig(supplied, retained, "resume"), {
      runtimeConfig: retained,
      runtimeParams: {},
    });
  }
  for (const supplied of [
    { tools: "bash" },
    { tools: "none" },
    { disallowed_tools: [] },
    { prompt_mode: "replace" },
  ]) {
    assert.throws(
      () => parsePiCallConfig(supplied, retained, "resume"),
      /Cannot reconfigure Pi/,
    );
  }
  assert.deepEqual(
    parsePiCallConfig({ tools: "none" }, { tools: [] }, "resume"),
    {
      runtimeConfig: { tools: [] },
      runtimeParams: {},
    },
  );
  for (const supplied of [
    { tools: [] },
    { disallowed_tools: [] },
    { prompt_mode: "replace" },
  ]) {
    assert.throws(
      () => parsePiCallConfig(supplied, {}, "resume"),
      /Cannot reconfigure Pi/,
    );
  }
});

test("Pi call config ignores foreign fields on spawn/resume and still validates own syntax", () => {
  for (const phase of ["spawn", "resume"] as const) {
    for (const key of [
      "review_target",
      "runtime_args",
      "runtimeParams",
      "future_option",
    ]) {
      for (const value of [undefined, null, false, [false], {}]) {
        assert.deepEqual(parsePiCallConfig({ [key]: value }, {}, phase), {
          runtimeConfig: {},
          runtimeParams: {},
        });
        assert.deepEqual(
          parsePiCallConfig(
            { [key]: value, tools: " read, read " },
            { [key]: "different", tools: ["read"] },
            phase,
          ),
          { runtimeConfig: { tools: ["read"] }, runtimeParams: {} },
        );
      }
    }
    assert.deepEqual(parsePiCallConfig({}, { future_option: true }, phase), {
      runtimeConfig: {},
      runtimeParams: {},
    });
    assert.throws(
      () =>
        parsePiCallConfig({ tools: [false], future_option: true }, {}, phase),
      /must contain tool names/,
    );
    for (const value of [null, [], false]) {
      assert.throws(
        () => parsePiCallConfig(value as never, {}, phase),
        /configuration must be an object/,
      );
      assert.throws(
        () => parsePiCallConfig({}, value as never, phase),
        /configuration must be an object/,
      );
    }
  }
  assert.throws(
    () =>
      parsePiCallConfig(
        { tools: "bash", foreign: true },
        { tools: "read" },
        "resume",
      ),
    /Cannot reconfigure Pi tools/,
  );
});

test("Pi task parser preserves ordinary tasks and controls but strips foreign task params", () => {
  const command = { type: "task" as const, prompt: "Inspect files" };
  assert.equal(parsePiTask(command), command);
  assert.equal(new PiRuntime().parseTask(command, options), command);
  assert.throws(
    () => parsePiTask({ type: "task", prompt: " " }),
    /must not be blank/,
  );
  for (const runtimeParams of [
    { tools: "read" },
    { prompt_mode: "append" },
    { review_target: { type: "uncommittedChanges" } },
    { future_option: null },
    {},
  ]) {
    const original = { ...command, runtimeParams };
    const parsed = parsePiTask(original);
    assert.deepEqual(parsed, command);
    assert.equal(Object.hasOwn(parsed, "runtimeParams"), false);
    assert.equal(parsePiTask(parsed), parsed);
    assert.equal(original.runtimeParams, runtimeParams);
  }
  for (const control of [
    { type: "steer", message: "Focus on tests" },
    { type: "cancel" },
  ] as RuntimeCommand[]) {
    assert.equal(new PiRuntime().parseTask(control, options), control);
  }
});

test("Pi task tools use explicit allow minus deny, including empty tools, without mutating commands", () => {
  const command: RuntimeCommand = {
    type: "task",
    prompt: "Inspect files",
    round: 2,
    instructions: { systemPrompt: "Keep role" },
  };
  const sessionOptions = {
    ...options,
    runtimeConfig: {
      tools: "read, bash, read",
      disallowed_tools: "bash, write",
    },
  };
  const expected = {
    ...command,
    instructions: { systemPrompt: "Keep role", tools: ["read"] },
  };
  const parsed = new PiRuntime().parseTask(
    { ...command, runtimeParams: { review_target: false, tools: false } },
    sessionOptions,
  );
  assert.deepEqual(parsed, expected);
  assert.deepEqual(parsePiTask(parsed, sessionOptions), expected);
  assert.deepEqual(command.instructions, { systemPrompt: "Keep role" });
  for (const tools of ["none", [], ""]) {
    assert.deepEqual(
      parsePiTask(command, { ...options, runtimeConfig: { tools } }),
      {
        ...command,
        instructions: { systemPrompt: "Keep role", tools: [] },
      },
    );
  }
  assert.equal(
    parsePiTask(command, {
      ...options,
      runtimeConfig: { disallowed_tools: "read" },
    }),
    command,
  );
  assert.deepEqual(
    parsePiTask({ type: "task", prompt: "Task" }, sessionOptions),
    {
      type: "task",
      prompt: "Task",
      instructions: { tools: ["read"] },
    },
  );
});

test("Pi validation and task parsing use session runtimeConfig before agent config", () => {
  const named = {
    ...agent,
    runtimeConfig: { tools: "bash", prompt_mode: "replace" },
  };
  const opts = { ...options, agent: named };
  assert.deepEqual(parsePiTask({ type: "task", prompt: "Task" }, opts), {
    type: "task",
    prompt: "Task",
    instructions: { tools: ["bash"] },
  });
  assert.deepEqual(
    parsePiTask(
      { type: "task", prompt: "Task" },
      { ...opts, runtimeConfig: { tools: "read" } },
    ),
    {
      type: "task",
      prompt: "Task",
      instructions: { tools: ["read"] },
    },
  );
  const runtime = new PiRuntime();
  assert.doesNotThrow(() =>
    runtime.validate({ ...opts, runtimeConfig: { runtime_args: [false] } }),
  );
  assert.throws(
    () =>
      runtime.validate({
        ...opts,
        agent: { ...named, runtimeConfig: { tools: false } },
      }),
    /CSV string or string array/,
  );
});

test("Pi keeps the empty named-body error for effective replace, but permits append and default unnamed sessions", () => {
  const runtime = new PiRuntime();
  for (const runtimeConfig of [{}, { prompt_mode: "replace" }]) {
    assert.throws(
      () =>
        runtime.validate({
          ...options,
          agent: { ...agent, systemPrompt: " \n " },
          runtimeConfig,
        }),
      /replace prompt_mode requires a non-empty agent body/,
    );
    assert.doesNotThrow(() =>
      runtime.validate({ ...options, agent, runtimeConfig }),
    );
  }
  assert.doesNotThrow(() => runtime.validate(options));
  assert.doesNotThrow(() =>
    runtime.validate({
      ...options,
      agent: { ...agent, systemPrompt: "" },
      runtimeConfig: { prompt_mode: "append" },
    }),
  );
  assert.throws(
    () =>
      runtime.create(
        { ...options, agent: { ...agent, systemPrompt: "" } },
        {
          mux: {
            start() {
              assert.fail("Must validate before creating resources");
            },
          } as never,
          emit() {},
        },
      ),
    /requires a non-empty agent body/,
  );
});
