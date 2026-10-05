import assert from "node:assert/strict";
import { test } from "node:test";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { codexReviewTargetSchema } from "./schema.ts";

const parameters = Type.Object({ review_target: codexReviewTargetSchema() });

test("review target tool schema exposes all native scopes and rejects malformed fields", () => {
  assert.equal(Value.Check(parameters, {}), true);
  for (const review_target of [
    { type: "uncommittedChanges" },
    { type: "baseBranch", branch: "main" },
    { type: "commit", sha: "abc" },
    { type: "commit", sha: "abc", title: null },
    { type: "commit", sha: "abc", title: "Fix bug" },
    { type: "custom", instructions: "Review security" },
  ]) {
    assert.equal(Value.Check(parameters, { review_target }), true);
    assert.equal(
      Value.Check(parameters, {
        review_target: { ...review_target, foreign: null, tools: 12 },
        typo: false,
      }),
      true,
    );
  }
  for (const review_target of [
    null,
    {},
    { type: "unknown" },
    { type: "baseBranch" },
    { type: "baseBranch", branch: " " },
    { type: "commit", sha: 123 },
    { type: "custom", instructions: "" },
  ]) {
    assert.equal(Value.Check(parameters, { review_target }), false);
  }
});

test("tool registrations receive independent review target schemas", () => {
  assert.notEqual(codexReviewTargetSchema(), codexReviewTargetSchema());
});
