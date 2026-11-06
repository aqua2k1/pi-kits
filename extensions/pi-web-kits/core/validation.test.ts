import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MAX_DOMAIN_COUNT,
  MAX_MAX_RESULTS,
  MAX_QUERY_LENGTH,
  MAX_RECENCY_DAYS,
  MIN_MAX_RESULTS,
} from "../shared/limits.ts";
import { WebSearchError } from "./errors.ts";
import type { SearchRequest } from "./types.ts";
import { normalizeSearchRequest } from "./validation.ts";

const validRequest: SearchRequest = { query: "test", maxResults: 5 };

function assertInvalid(request: SearchRequest): void {
  assert.throws(
    () => normalizeSearchRequest(request),
    (error: unknown) =>
      error instanceof WebSearchError && error.code === "invalid-config",
  );
}

test("normalizeSearchRequest: rejects blank and oversized queries", () => {
  assertInvalid({ ...validRequest, query: "   " });
  assertInvalid({
    ...validRequest,
    query: "q".repeat(MAX_QUERY_LENGTH + 1),
  });

  assert.deepEqual(
    normalizeSearchRequest({ ...validRequest, query: "  trimmed query  " }),
    { ...validRequest, query: "trimmed query" },
  );
});

test("normalizeSearchRequest: rejects malformed and oversized hostname labels", () => {
  for (const domain of [
    "example..com",
    "-example.com",
    "example-.com",
    "example_com",
    `${"a".repeat(64)}.example.com`,
    ["a", "b", "c", "d"].map((label) => label.repeat(63)).join("."),
  ]) {
    assertInvalid({ ...validRequest, domains: [domain] });
  }
});

test("normalizeSearchRequest: enforces the domain count and removes normalized duplicates", () => {
  const domains = Array.from(
    { length: MAX_DOMAIN_COUNT },
    (_, index) => `site-${index}.example`,
  );
  const atLimit = normalizeSearchRequest({ ...validRequest, domains });
  assert.deepEqual(atLimit.domains, domains);
  assertInvalid({ ...validRequest, domains: [...domains, "extra.example"] });

  const deduplicated = normalizeSearchRequest({
    ...validRequest,
    domains: [" Example.COM ", "example.com", "other.example", "OTHER.EXAMPLE"],
  });
  assert.deepEqual(deduplicated.domains, ["example.com", "other.example"]);
});

test("normalizeSearchRequest: accepts wildcard hostnames", () => {
  const normalized = normalizeSearchRequest({
    ...validRequest,
    domains: ["*.Example.COM"],
  });
  assert.deepEqual(normalized.domains, ["*.example.com"]);
});

test("normalizeSearchRequest: accepts numeric boundaries and rejects out-of-range values", () => {
  for (const maxResults of [MIN_MAX_RESULTS, MAX_MAX_RESULTS]) {
    assert.equal(
      normalizeSearchRequest({ ...validRequest, maxResults }).maxResults,
      maxResults,
    );
  }
  for (const maxResults of [
    MIN_MAX_RESULTS - 1,
    MAX_MAX_RESULTS + 1,
    1.5,
    NaN,
  ]) {
    assertInvalid({ ...validRequest, maxResults });
  }

  for (const recencyDays of [1, MAX_RECENCY_DAYS]) {
    assert.equal(
      normalizeSearchRequest({ ...validRequest, recencyDays }).recencyDays,
      recencyDays,
    );
  }
  for (const recencyDays of [0, MAX_RECENCY_DAYS + 1, 1.5, NaN]) {
    assertInvalid({ ...validRequest, recencyDays });
  }
});
