import assert from "node:assert/strict";
import { test } from "node:test";
import { Value } from "typebox/value";
import {
  type FetchMachineOutput,
  FetchSourceSchema,
  type SearchMachineOutput,
  SearchOutputSchema,
} from "./schema.ts";

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;

function assertType<T extends true>(value: T) {
  assert.equal(value, true);
}

test("output enums infer literal unions with TypeBox", () => {
  assertType<
    Equal<
      SearchMachineOutput["backend"],
      "searxng" | "codex-alpha-search" | "github-gh"
    >
  >(true);
  assertType<Equal<FetchMachineOutput["source"], "native-http" | "github-gh">>(
    true,
  );
});

test("output enums serialize as explicit string JSON Schemas", () => {
  const backend = SearchOutputSchema.properties.backend;
  for (const [schema, values] of [
    [backend, ["searxng", "codex-alpha-search", "github-gh"]],
    [FetchSourceSchema, ["native-http", "github-gh"]],
  ] as const) {
    assert.deepEqual(JSON.parse(JSON.stringify(schema)), {
      type: "string",
      enum: values,
    });
    for (const value of values) assert.ok(Value.Check(schema, value));
    for (const value of ["github-clone", "unknown", "", 1, null, [], {}]) {
      assert.equal(Value.Check(schema, value), false);
    }
  }
});
