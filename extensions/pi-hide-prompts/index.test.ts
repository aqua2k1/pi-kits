import assert from "node:assert/strict";
import { test } from "node:test";
import { applyDocsGuidance } from "./index.ts";

const guidance =
  "Use the current project's documentation and implementation as the source of truth; when an interface or convention is unclear, consult the relevant documentation before making changes.";

test("adds project documentation guidance to custom sections", () => {
  const sections: Record<string, string> = {};
  assert.equal(applyDocsGuidance(sections), undefined);
  assert.deepEqual(sections, { docs: guidance });
});

test("overrides docs while preserving every other section", () => {
  const sections = {
    docs: "Pi documentation",
    rules: "Keep rules",
    tool_guidance: "Keep tool guidance",
  };
  applyDocsGuidance(sections);
  assert.deepEqual(sections, {
    docs: guidance,
    rules: "Keep rules",
    tool_guidance: "Keep tool guidance",
  });
});

test("applying guidance repeatedly does not duplicate it", () => {
  const sections: Record<string, string> = {};
  applyDocsGuidance(sections);
  applyDocsGuidance(sections);
  assert.deepEqual(sections, { docs: guidance });
});
