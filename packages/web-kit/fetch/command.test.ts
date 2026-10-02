import assert from "node:assert/strict";
import { test } from "node:test";
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

test("ProcessCommandRunner handles timeout and cancellation during shutdown", async () => {
  const runner = new ProcessCommandRunner();
  const controller = new AbortController();
  const promise = runner.run(
    process.execPath,
    ["-e", "process.on('SIGTERM', () => {}); setTimeout(() => {}, 5_000)"],
    {
      signal: controller.signal,
      timeoutMs: 100,
      maxStdoutBytes: 10,
      maxStderrBytes: 10,
    },
  );
  const abortTimer = setTimeout(() => controller.abort(), 110);
  const commandResult = await promise;
  clearTimeout(abortTimer);
  assert.equal(commandResult.timedOut, true);
  assert.equal(commandResult.aborted, true);
});
