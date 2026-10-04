import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveFallbackProvider } from "./routing.ts";

test("fallback comes from provider inventory, with explicit configuration taking priority", () => {
  assert.equal(resolveFallbackProvider("searxng"), "codex-alpha-search");
  assert.equal(resolveFallbackProvider("codex-alpha-search"), "searxng");
  assert.equal(
    resolveFallbackProvider("searxng", undefined, ["searxng"]),
    undefined,
  );
  assert.equal(
    resolveFallbackProvider("searxng", "codex-alpha-search", []),
    "codex-alpha-search",
  );
});
