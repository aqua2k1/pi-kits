import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertNotCancelled,
  errorCodeForStatus,
  errorFromStatus,
  toWebSearchError,
  WebSearchError,
} from "./errors.ts";

test("errorCodeForStatus: classifies common provider responses", () => {
  assert.equal(errorCodeForStatus(400), "request");
  assert.equal(errorCodeForStatus(401), "auth");
  assert.equal(errorCodeForStatus(403), "auth");
  assert.equal(errorCodeForStatus(404), "unsupported");
  assert.equal(errorCodeForStatus(408), "timeout");
  assert.equal(errorCodeForStatus(429), "rate-limit");
  assert.equal(errorCodeForStatus(500), "server");
  assert.equal(errorCodeForStatus(200), "invalid-response");
});

test("errorFromStatus: exposes only a classified status and safe message", () => {
  const error = errorFromStatus(401, "searxng");
  assert.equal(error.code, "auth");
  assert.equal(error.provider, "searxng");
  assert.equal(error.status, 401);
  assert.equal(
    error.message,
    "searxng authentication is unavailable or was rejected.",
  );
  assert.doesNotMatch(error.message, /synthetic-secret|response body/i);
});

test("toWebSearchError: classifies abort, timeout, and network failures safely", () => {
  const abort = new DOMException("request stopped", "AbortError");
  assert.equal(toWebSearchError(abort, "searxng").code, "cancelled");
  assert.equal(
    toWebSearchError(new TypeError("fetch failed"), "searxng").code,
    "network",
  );
  assert.equal(
    toWebSearchError(new Error("socket timed out"), "searxng").code,
    "timeout",
  );
  const classified = toWebSearchError(
    new Error("synthetic-secret response body"),
    "searxng",
  );
  assert.equal(classified.code, "network");
  assert.equal(classified.message, "searxng could not be reached.");
  assert.doesNotMatch(classified.message, /synthetic-secret|response body/i);
});

test("toWebSearchError: retains codes but never trusts a classified error's message or provider", () => {
  const existing = new WebSearchError(
    "invalid-response",
    "Bearer fixture-secret",
    { provider: "fixture-secret", status: 502 },
  );
  const safe = toWebSearchError(existing);
  assert.equal(safe.code, "invalid-response");
  assert.equal(safe.status, 502);
  assert.doesNotMatch(
    `${safe.stack} ${JSON.stringify(safe)}`,
    /fixture-secret/,
  );
  assert.equal(toWebSearchError(existing, "searxng").provider, "searxng");
});

test("assertNotCancelled: rejects an already aborted signal with a safe error", () => {
  const controller = new AbortController();
  assert.doesNotThrow(() => assertNotCancelled(controller.signal));
  controller.abort(new Error("synthetic parent reason"));
  assert.throws(
    () => assertNotCancelled(controller.signal),
    (error: unknown) => {
      assert.ok(error instanceof WebSearchError);
      assert.equal(error.code, "cancelled");
      assert.equal(error.message, "Web search was cancelled.");
      assert.doesNotMatch(error.message, /synthetic parent reason/);
      return true;
    },
  );
});
