import assert from "node:assert/strict";
import { test } from "node:test";
import { RequestError } from "../shared/request.ts";
import { errorFromStatus, toWebFetchError, WebFetchError } from "./errors.ts";

test("request errors retain fetch status policy and transport classifications", () => {
  for (const status of [400, 401, 403, 404, 408, 429, 500]) {
    const error = toWebFetchError(new RequestError("status", status));
    assert.equal(error.code, errorFromStatus(status).code);
    assert.equal(error.status, status);
    assert.equal(error.source, "native-http");
  }
  for (const code of [
    "network",
    "timeout",
    "cancelled",
    "invalid-response",
  ] as const) {
    const error = toWebFetchError(new RequestError(code));
    assert.equal(error.code, code);
    assert.equal(error.source, "native-http");
  }
});

test("fetch errors classify status without exposing response text", () => {
  const error = errorFromStatus(401, "github-gh");
  assert.equal(error.code, "auth");
  assert.equal(error.status, 401);
  assert.doesNotMatch(error.message, /body|secret/i);
});

test("toWebFetchError strips raw transport and config messages", () => {
  const safe = toWebFetchError(new Error("secret response body"));
  assert.equal(safe.code, "network");
  assert.doesNotMatch(`${safe.message} ${safe.stack}`, /secret|response body/);
  const config = toWebFetchError(
    new WebFetchError("invalid-config", "secret config details"),
  );
  assert.equal(config.code, "invalid-config");
  assert.doesNotMatch(config.message, /secret/);
});
