import assert from "node:assert/strict";
import { test } from "node:test";
import {
  calculateMetrics,
  createMeasurement,
  recordText,
  startMessage,
  startRequest,
} from "./meter.ts";

test("TTFT does not depend on response usage or duration", () => {
  const state = recordText(
    startMessage(startRequest(createMeasurement(), 100)),
    "Hello",
    900,
  );
  for (const response of [
    { stopReason: "error" },
    { stopReason: "stop", durationMs: 5000, usage: { output: 315 } },
  ]) {
    assert.equal(calculateMetrics(state, response, 5100).ttftMs, 800);
  }
});

test("TPS does not depend on first-text timing", () => {
  const request = startMessage(startRequest(createMeasurement(), 100));
  const response = { stopReason: "stop", usage: { output: 315 } };
  for (const state of [request, recordText(request, "Hello", 900)]) {
    assert.equal(calculateMetrics(state, response, 5100).tps, 63);
  }
});

test("measurement transformations are immutable and first-text time is stable", () => {
  const initial = Object.freeze(createMeasurement());
  const request = Object.freeze(startRequest(initial, 100));
  const message = Object.freeze(startMessage(request));
  const first = Object.freeze(recordText(message, "Hello", 900));
  const later = recordText(first, " world", 2000);

  assert.deepEqual(initial, { messageStarted: false });
  assert.equal(request.requestStartedAt, 100);
  assert.equal(request.messageStarted, false);
  assert.equal(message.firstTextAt, undefined);
  assert.equal(first.firstTextAt, 900);
  assert.equal(later, first);
  assert.deepEqual(
    calculateMetrics(
      later,
      { stopReason: "stop", usage: { output: 315 } },
      5100,
    ),
    { ttftMs: 800, tps: 63 },
  );
});

test("empty or unassociated text does not start a measurement", () => {
  const initial = createMeasurement();
  assert.equal(recordText(initial, "Hello", 100), initial);
  const message = startMessage(initial);
  assert.equal(recordText(message, "Hello", 200), message);
  const request = startMessage(startRequest(initial, 0));
  assert.equal(recordText(request, "", 300), request);
});

test("native duration works without a provider hook", () => {
  const result = calculateMetrics(
    createMeasurement(),
    { durationMs: 5000, usage: { output: 315 }, stopReason: "length" },
    100_000,
  );
  assert.deepEqual(result, { ttftMs: undefined, tps: 63 });
});

test("invalid native duration falls back to observed request boundaries", () => {
  const state = startRequest(createMeasurement(), 100);
  for (const durationMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(
      calculateMetrics(
        state,
        { durationMs, usage: { output: 315 }, stopReason: "stop" },
        5100,
      ).tps,
      63,
    );
  }
});

test("invalid elapsed time never produces negative or infinite metrics", () => {
  const state = recordText(
    startMessage(startRequest(createMeasurement(), 1000)),
    "Hello",
    500,
  );
  assert.deepEqual(
    calculateMetrics(state, { usage: { output: 315 }, stopReason: "stop" }, 0),
    { ttftMs: undefined, tps: undefined },
  );
});
