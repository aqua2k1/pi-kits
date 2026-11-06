import assert from "node:assert/strict";
import { test } from "node:test";
import { errorFromStatus, toWebFetchError, WebFetchError } from "./errors.ts";

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
