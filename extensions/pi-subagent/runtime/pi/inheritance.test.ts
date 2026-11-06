import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { parseAgentDefinition } from "../../agents.ts";
import type { RuntimeOptions } from "../index.ts";
import { parsePiCallConfig, parsePiConfig } from "./config.ts";
import { PiRuntime } from "./index.ts";

const options: RuntimeOptions = { id: "inherit-test", cwd: "/tmp" };

function parentSession() {
  const parent = SessionManager.inMemory("/tmp");
  parent.appendMessage({ role: "user", content: "Original", timestamp: 1 });
  return parent;
}

test("Pi inherit_context is strictly boolean, preserves omission, and defaults effectively false", () => {
  assert.equal(parsePiConfig({}).inherit_context, undefined);
  assert.equal(parsePiConfig({}).inherit_context ?? false, false);
  for (const inherit_context of [true, false]) {
    assert.deepEqual(parsePiConfig({ inherit_context }), { inherit_context });
  }
  for (const inherit_context of [null, "true", "false", "yes", 1, 0, [], {}]) {
    assert.throws(
      () => parsePiConfig({ inherit_context }),
      /Pi inherit_context must be a boolean/,
    );
  }
  assert.deepEqual(parsePiConfig({ context: {} }), {});
});

test("Pi inheritance is static call config with per-key session precedence and immutable resume", () => {
  for (const inherit_context of [true, false]) {
    assert.deepEqual(parsePiCallConfig({ inherit_context }, {}, "spawn"), {
      runtimeConfig: { inherit_context },
      runtimeParams: {},
    });
    assert.deepEqual(
      parsePiCallConfig(
        { inherit_context: !inherit_context, tools: "read" },
        { inherit_context },
        "spawn",
      ),
      {
        runtimeConfig: { tools: ["read"], inherit_context },
        runtimeParams: {},
      },
    );
    for (const supplied of [{}, { inherit_context }]) {
      assert.deepEqual(
        parsePiCallConfig(supplied, { inherit_context }, "resume"),
        { runtimeConfig: { inherit_context }, runtimeParams: {} },
      );
    }
    assert.throws(
      () =>
        parsePiCallConfig(
          { inherit_context: !inherit_context },
          { inherit_context },
          "resume",
        ),
      /Cannot reconfigure Pi inherit_context on resume/,
    );
    assert.throws(
      () => parsePiCallConfig({ inherit_context }, {}, "resume"),
      /Cannot reconfigure Pi inherit_context on resume/,
    );
  }
  assert.throws(
    () => parsePiCallConfig({ inherit_context: "true" }, {}, "resume"),
    /must be a boolean/,
  );
});

test("Pi prepareSpawn never accesses parent context when inheritance is false or omitted", () => {
  const context = {
    get getBranch() {
      return assert.fail("Opt-out must not access the parent session");
    },
  };
  for (const runtimeConfig of [{}, { inherit_context: false }]) {
    const original = { ...options, runtimeConfig, context };
    const prepared = new PiRuntime().prepareSpawn(original);
    assert.equal(prepared.parentSession, undefined);
    assert.equal(prepared.context, undefined);
    assert.equal(original.context, context);
  }
});

test("Pi prepareSpawn captures an independent snapshot immediately and drops host context", (t) => {
  const parent = parentSession();
  const getBranch = t.mock.method(parent, "getBranch");
  const original = {
    ...options,
    runtimeConfig: { inherit_context: true },
    context: parent,
  };
  const runtime = new PiRuntime();
  runtime.validate(original);
  assert.equal(getBranch.mock.callCount(), 0);
  const prepared = runtime.prepareSpawn(original);
  assert.equal(getBranch.mock.callCount(), 1);
  const snapshot = prepared.parentSession;
  assert.ok(snapshot);
  assert.equal(prepared.context, undefined);
  assert.equal(original.context, parent);
  assert.equal(original.parentSession, undefined);
  const frozen = JSON.stringify(snapshot);
  assert.notEqual(snapshot.entries[1], parent.getBranch()[0]);
  parent.appendMessage({ role: "user", content: "Later", timestamp: 2 });
  assert.equal(JSON.stringify(snapshot), frozen);
  assert.doesNotMatch(JSON.stringify(snapshot), /Later/);
});

test("Pi prepareSpawn requires valid host session context only when capture is requested", () => {
  for (const context of [
    undefined,
    null,
    false,
    "session",
    {},
    { getBranch() {} },
  ]) {
    assert.throws(
      () =>
        new PiRuntime().prepareSpawn({
          ...options,
          runtimeConfig: { inherit_context: true },
          context,
        }),
      /Pi inherit_context requires a valid host session context/,
    );
  }
});

test("Pi prepareSpawn preserves explicit trusted snapshots regardless of inheritance config", () => {
  const parentSession = { entries: [] };
  const context = {
    get getBranch() {
      return assert.fail("An explicit snapshot must not be recaptured");
    },
  };
  for (const runtimeConfig of [
    {},
    { inherit_context: false },
    { inherit_context: true },
  ]) {
    const prepared = new PiRuntime().prepareSpawn({
      ...options,
      runtimeConfig,
      parentSession,
      context,
    });
    assert.equal(prepared.parentSession, parentSession);
    assert.equal(prepared.context, undefined);
  }
});

test("Pi prepareSpawn reads agent inheritance config unless session config overrides it", () => {
  const agent = parseAgentDefinition(
    "---\nruntime_config:\n  inherit_context: true\n---\nRole",
    "/agents/test.md",
    "project",
  );
  const runtime = new PiRuntime();
  const prepared = runtime.prepareSpawn({
    ...options,
    agent,
    context: parentSession(),
  });
  assert.ok(prepared.parentSession);
  const context = {
    getBranch() {
      assert.fail("Session config takes precedence");
    },
  };
  for (const runtimeConfig of [{}, { inherit_context: false }]) {
    assert.equal(
      runtime.prepareSpawn({ ...options, agent, runtimeConfig, context })
        .parentSession,
      undefined,
    );
  }
});

test("Pi resume and session creation never recapture the prepared parent", async (t) => {
  const parent = parentSession();
  const runtime = new PiRuntime();
  const prepared = runtime.prepareSpawn({
    ...options,
    runtimeConfig: { inherit_context: true },
    context: parent,
  });
  t.mock.method(parent, "getBranch", () => {
    assert.fail("Resume must not recapture the host session");
  });
  const resumed = runtime.parseCallConfig(
    { inherit_context: true },
    prepared.runtimeConfig ?? {},
    "resume",
  );
  const retained = { ...prepared, runtimeConfig: resumed.runtimeConfig };
  runtime.validate(retained);
  assert.deepEqual(
    runtime.parseTask({ type: "task", prompt: "Next" }, retained),
    {
      type: "task",
      prompt: "Next",
    },
  );
  const session = runtime.create(retained, {
    mux: {} as never,
    emit() {},
  });
  await session.close();
  assert.equal(retained.parentSession, prepared.parentSession);
  assert.equal(retained.context, undefined);
});

test("Pi capture of an empty branch starts fresh without retaining context or recapturing", async () => {
  const runtime = new PiRuntime();
  const context = SessionManager.inMemory("/tmp");
  const prepared = runtime.prepareSpawn({
    ...options,
    runtimeConfig: { inherit_context: true },
    context,
  });
  assert.equal(prepared.parentSession, undefined);
  assert.equal(prepared.context, undefined);
  const session = runtime.create(prepared, { mux: {} as never, emit() {} });
  await session.close();
});
