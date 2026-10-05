import assert from "node:assert/strict";
import { test } from "node:test";
import { parseAgentDefinition } from "../../agents.ts";
import { parsePiConfig, parsePiTask } from "./config.ts";
import { PiRuntime } from "./index.ts";

test("Pi parser preserves ordinary tasks and rejects Codex-only configuration", () => {
  assert.deepEqual(parsePiConfig({}), {});
  for (const runtime_args of ["review, search", ["review"], []]) {
    assert.throws(
      () => parsePiConfig({ runtime_args }),
      /not supported by the Pi runtime/,
    );
  }
  assert.throws(
    () => parsePiConfig({ future_option: true }),
    /Unsupported Pi runtime configuration field/,
  );
  const command = { type: "task" as const, prompt: "Inspect files" };
  assert.equal(parsePiTask(command), command);
  assert.throws(
    () => parsePiTask({ type: "task", prompt: " " }),
    /must not be blank/,
  );
  assert.throws(
    () =>
      parsePiTask({
        ...command,
        runtimeParams: { review_target: { type: "uncommittedChanges" } },
      }),
    /not supported by the Pi runtime/,
  );
  const steer = { type: "steer" as const, message: "Focus on tests" };
  assert.equal(parsePiTask(steer), steer);
});

test("Pi runtime validates raw agent configuration before acquiring resources", () => {
  const agent = parseAgentDefinition(
    "---\nruntime_args: review\n---\nRole",
    "/agents/pi.md",
    "project",
  );
  assert.throws(
    () => new PiRuntime().validate({ id: "test", cwd: "/tmp", agent }),
    /runtime_args is not supported/,
  );
});
