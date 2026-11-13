import assert from "node:assert/strict";
import { test } from "node:test";
import type { MuxAdapter } from "./index.ts";
import {
  createMuxRegistry,
  type MuxFactoryOptions,
  type MuxProvider,
} from "./registry.ts";

function provider(overrides: Partial<MuxProvider> = {}): MuxProvider {
  return {
    id: "test",
    matches: () => true,
    create: () => ({}) as MuxAdapter,
    ...overrides,
  };
}

test("registries are isolated and empty resolution returns undefined", () => {
  const first = createMuxRegistry();
  const second = createMuxRegistry();
  first.registerMux(provider());
  assert.ok(first.resolveMux({}));
  assert.equal(second.resolveMux({}), undefined);
});

test("duplicate ids are rejected without replacing or appending a provider", () => {
  const registry = createMuxRegistry();
  const adapter = {} as MuxAdapter;
  const original = provider({ create: () => adapter });
  registry.registerMux(original);
  assert.throws(
    () => registry.registerMux(original),
    /Mux provider already registered: test/,
  );
  assert.throws(
    () =>
      registry.registerMux(
        provider({ create: () => assert.fail("duplicate factory") }),
      ),
    /Mux provider already registered: test/,
  );
  assert.equal(registry.resolveMux({}), adapter);
});

test("resolution matches in registration order and creates only the first match", () => {
  const registry = createMuxRegistry();
  const env = { MARKER: "1" };
  const calls: string[] = [];
  const adapter = {} as MuxAdapter;
  for (const id of ["unmatched", "first", "later"]) {
    registry.registerMux(
      provider({
        id,
        matches(actual) {
          assert.equal(actual, env);
          calls.push(`match:${id}`);
          return id !== "unmatched";
        },
        create() {
          calls.push(`create:${id}`);
          return adapter;
        },
      }),
    );
  }
  assert.equal(registry.resolveMux(env), adapter);
  assert.deepEqual(calls, ["match:unmatched", "match:first", "create:first"]);
});

test("unmatched providers never create adapters", () => {
  const registry = createMuxRegistry();
  registry.registerMux(
    provider({
      matches: () => false,
      create: () => assert.fail("unmatched factory"),
    }),
  );
  assert.equal(registry.resolveMux({}), undefined);
});

test("factory receives warning callback and the matched environment", () => {
  const registry = createMuxRegistry();
  const warnings: string[] = [];
  const env = { MATCHED: "1" };
  const options: MuxFactoryOptions = {
    warn: (message) => warnings.push(message),
    env: { IGNORED: "1" },
  };
  registry.registerMux(
    provider({
      create(actual) {
        assert.equal(actual?.env, env);
        assert.equal(actual?.warn, options.warn);
        actual?.warn?.("adapter warning");
        return {} as MuxAdapter;
      },
    }),
  );
  registry.resolveMux(env, options);
  assert.deepEqual(warnings, ["adapter warning"]);
});

test("factory failure propagates without fallback", () => {
  const registry = createMuxRegistry();
  const failure = new Error("factory failed");
  registry.registerMux(
    provider({
      create() {
        throw failure;
      },
    }),
  );
  registry.registerMux(
    provider({
      id: "fallback",
      create: () => assert.fail("must not fall back"),
    }),
  );
  assert.throws(
    () => registry.resolveMux({}),
    (error) => error === failure,
  );
});

test("resolution defaults to process.env and creates a fresh adapter each time", () => {
  const registry = createMuxRegistry();
  registry.registerMux(
    provider({
      matches(env) {
        assert.equal(env, process.env);
        return true;
      },
      create(options) {
        assert.equal(options?.env, process.env);
        assert.equal(options?.warn, undefined);
        return {} as MuxAdapter;
      },
    }),
  );
  assert.notEqual(registry.resolveMux(), registry.resolveMux());
});
