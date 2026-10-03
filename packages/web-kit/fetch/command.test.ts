import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter, getEventListeners } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { type TestContext, test } from "node:test";
import { ProcessCommandRunner } from "./command.ts";

test("ProcessCommandRunner bounds stdout without a shell", async () => {
  const runner = new ProcessCommandRunner();
  const result = await runner.run(
    process.execPath,
    ["-e", "process.stdout.write('x'.repeat(100))"],
    {
      timeoutMs: 5_000,
      maxStdoutBytes: 10,
      maxStderrBytes: 10,
    },
  );
  assert.equal(result.stdoutTruncated, true);
  assert.equal(result.stdout.length, 10);
});

test("ProcessCommandRunner classifies cancellation before its timeout", async () => {
  const runner = new ProcessCommandRunner();
  const controller = new AbortController();
  const promise = runner.run(
    process.execPath,
    ["-e", "setTimeout(() => {}, 5_000)"],
    {
      signal: controller.signal,
      timeoutMs: 1_000,
      maxStdoutBytes: 10,
      maxStderrBytes: 10,
    },
  );
  const abortTimer = setTimeout(() => controller.abort(), 10);
  const commandResult = await promise;
  clearTimeout(abortTimer);
  assert.equal(commandResult.aborted, true);
  assert.equal(commandResult.timedOut, false);
});

function mockCommandChild(t: TestContext) {
  const signals: NodeJS.Signals[] = [];
  // No pid: shutdown uses child.kill rather than sending OS process-group signals.
  const child = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    kill(signal: NodeJS.Signals) {
      signals.push(signal);
      return true;
    },
  });
  t.mock.method(childProcess, "spawn", () => child);
  t.after(() => {
    t.mock.reset();
    syncBuiltinESMExports();
  });
  // Update the runner's named spawn import, both here and after restoring it.
  syncBuiltinESMExports();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  return { child, signals };
}

// Spawn and timer mocks are process-wide, so these tests must not run concurrently.
test("ProcessCommandRunner handles timeout and cancellation during shutdown", {
  concurrency: false,
}, async (t) => {
  const { child, signals } = mockCommandChild(t);
  const runner = new ProcessCommandRunner();
  const controller = new AbortController();
  const promise = runner.run("mock-command", [], {
    signal: controller.signal,
    timeoutMs: 100,
    maxStdoutBytes: 10,
    maxStderrBytes: 10,
  });

  assert.deepEqual(signals, []);
  t.mock.timers.tick(100);
  assert.deepEqual(signals, ["SIGTERM"]);
  t.mock.timers.tick(10);
  controller.abort();
  assert.deepEqual(signals, ["SIGTERM"]);

  // At 350ms, escalation must still use the original timeout's deadline.
  t.mock.timers.tick(240);
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
  child.emit("close", null, "SIGKILL");
  const commandResult = await promise;
  assert.equal(commandResult.signal, "SIGKILL");
  assert.equal(commandResult.timedOut, true);
  assert.equal(commandResult.aborted, true);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("ProcessCommandRunner cleans up when the child closes before cancellation", {
  concurrency: false,
}, async (t) => {
  const { child, signals } = mockCommandChild(t);
  const clearTimeout = t.mock.method(globalThis, "clearTimeout");
  const runner = new ProcessCommandRunner();
  const controller = new AbortController();
  const promise = runner.run("mock-command", [], {
    signal: controller.signal,
    timeoutMs: 100,
    maxStdoutBytes: 10,
    maxStderrBytes: 10,
  });

  assert.equal(getEventListeners(controller.signal, "abort").length, 1);
  t.mock.timers.tick(100);
  assert.deepEqual(signals, ["SIGTERM"]);
  child.emit("close", null, "SIGTERM");
  const commandResult = await promise;
  assert.equal(commandResult.signal, "SIGTERM");
  assert.equal(commandResult.timedOut, true);
  assert.equal(commandResult.aborted, false);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  assert.equal(clearTimeout.mock.callCount(), 2); // Timeout and escalation timers.

  t.mock.timers.tick(10);
  controller.abort();
  t.mock.timers.tick(1_000);
  assert.deepEqual(signals, ["SIGTERM"]);
  assert.equal(commandResult.aborted, false);
});
