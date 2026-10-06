import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AgentSnapshot, SubagentManager } from "../manager.ts";
import { HerdrAdapter, runHerdr } from "../mux/herdr.ts";
import type { SessionUpdate } from "../runtime/index.ts";

// Explicit opt-in: invokes real models and creates only owned Herdr resources.
if (process.env.HERDR_ENV !== "1" || process.env.PI_KITS_HERDR_LIVE !== "1") {
  throw new Error(
    "Run inside Herdr with PI_KITS_HERDR_LIVE=1; this test uses real models.",
  );
}
const cwd = await mkdtemp(join(tmpdir(), "pi-kits-herdr-live-"));
const rootPanes = new Map<string, string>();
const binary = process.env.HERDR_BIN_PATH ?? "herdr";
const adapter = new HerdrAdapter({
  runner: async (bin, argv, options) => {
    const result = await runHerdr(bin, argv, options);
    if (
      argv[0] === "workspace" &&
      argv[1] === "create" &&
      result.exitCode === 0
    ) {
      const label = argv[argv.indexOf("--label") + 1];
      const envelope = JSON.parse(result.stdout);
      rootPanes.set(
        label.replace(/^pi-subagent-/, ""),
        envelope.result.root_pane.pane_id,
      );
    }
    return result;
  },
});
const completions: AgentSnapshot[] = [];
const sessionUpdates: { snapshot: AgentSnapshot; update: SessionUpdate }[] = [];
const manager = new SubagentManager(adapter, {
  maxConcurrent: 1,
  startupTimeoutMs: 60_000,
  runtimeExecutables: { codex: process.env.PI_KITS_CODEX_BIN },
  onComplete: (snapshot) => completions.push({ ...snapshot }),
  onSessionUpdate: (snapshot, update) =>
    sessionUpdates.push({ snapshot: { ...snapshot }, update: { ...update } }),
});
async function herdr(argv: string[]) {
  const result = await runHerdr(binary, argv, {
    timeoutMs: 150_000,
    maxOutputBytes: 256 * 1024,
  });
  if (result.exitCode !== 0 && argv[0] === "agent" && argv[1] === "prompt") {
    const screen = await runHerdr(
      binary,
      [
        "pane",
        "read",
        argv[2],
        "--source",
        "recent-unwrapped",
        "--lines",
        "100",
      ],
      { timeoutMs: 10_000, maxOutputBytes: 64 * 1024 },
    );
    console.error(
      JSON.stringify({ check: "prompt-failure-screen", screen: screen.stdout }),
    );
  }
  assert.equal(result.exitCode, 0, `Herdr command failed: ${result.stderr}`);
  return result.stdout;
}
async function until(
  id: string,
  predicate: (snapshot: AgentSnapshot) => boolean,
  ms = 120_000,
) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const snapshot = manager.get(id);
    if (predicate(snapshot)) return snapshot;
    if (snapshot.status === "error" || snapshot.status === "disconnected") {
      throw new Error(`Unexpected failure: ${JSON.stringify(snapshot)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Timed out: ${JSON.stringify(manager.get(id))}`);
}
function assertResult(
  snapshot: AgentSnapshot,
  source: "managed" | "user_interaction",
  previousRevision: number,
  outcome: "completed" | "aborted" | "error" = "completed",
) {
  assert.equal(snapshot.resultSource, source);
  assert.equal(snapshot.resultRevision, previousRevision + 1);
  assert.ok(Number.isSafeInteger(snapshot.resultUpdatedAt));
  assert.ok((snapshot.resultUpdatedAt ?? 0) > 0);
  assert.ok((snapshot.resultUpdatedAt ?? Infinity) <= Date.now());
  assert.equal(snapshot.resultOutcome, outcome);
  assert.equal(snapshot.resultError, undefined);
}
function resultMetadata(snapshot: AgentSnapshot) {
  return {
    result: snapshot.result,
    resultSource: snapshot.resultSource,
    resultRevision: snapshot.resultRevision,
    resultUpdatedAt: snapshot.resultUpdatedAt,
    resultOutcome: snapshot.resultOutcome,
    resultError: snapshot.resultError,
    truncated: snapshot.truncated,
  };
}
function managedState(snapshot: AgentSnapshot) {
  return {
    status: snapshot.status,
    round: snapshot.round,
    error: snapshot.error,
    createdAt: snapshot.createdAt,
    startedAt: snapshot.startedAt,
    completedAt: snapshot.completedAt,
    turnCount: snapshot.turnCount,
    toolUses: snapshot.toolUses,
    totalTokens: snapshot.totalTokens,
    contextPercent: snapshot.contextPercent,
    compactionCount: snapshot.compactionCount,
  };
}
async function completed(id: string, previousRevision = 0) {
  const result = await until(
    id,
    (snapshot) =>
      snapshot.status === "completed" &&
      (snapshot.resultRevision ?? 0) > previousRevision,
  );
  assertResult(result, "managed", previousRevision);
  const callbacks = completions.filter(
    (snapshot) => snapshot.id === id && snapshot.round === result.round,
  );
  assert.equal(callbacks.length, 1);
  assert.deepEqual(resultMetadata(callbacks[0]), resultMetadata(result));
  assert.deepEqual(managedState(callbacks[0]), managedState(result));
  console.log(
    JSON.stringify({
      check: "completed",
      runtime: result.runtime,
      round: result.round,
      result: result.result,
      resultSource: result.resultSource,
      resultRevision: result.resultRevision,
      resultUpdatedAt: result.resultUpdatedAt,
      toolUses: result.toolUses,
      totalTokens: result.totalTokens,
    }),
  );
  return result;
}
async function readyCodexPane(pane: string) {
  // Startup can briefly show resumed history before the update chooser mounts.
  await new Promise((resolve) => setTimeout(resolve, 5000));
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const screen = await herdr([
      "pane",
      "read",
      pane,
      "--source",
      "visible",
      "--lines",
      "100",
    ]);
    // The update chooser looks idle to Herdr. Never submit a task into it:
    // Enter would select Update now rather than send the requested prompt.
    if (screen.includes("Update now") && screen.includes("esc skip")) {
      await herdr(["pane", "send-keys", pane, "escape"]);
      console.log(JSON.stringify({ check: "skip-codex-update-dialog", pane }));
    } else if (screen.includes("OpenAI Codex") || screen.includes("GPT-")) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Codex native pane did not become ready: ${pane}`);
}

async function nativeDialogue(
  id: string,
  pane: string,
  baseline: AgentSnapshot,
  responses: readonly [string, string],
) {
  const completionCount = completions.filter(
    (snapshot) => snapshot.id === id,
  ).length;
  const updatesBefore = sessionUpdates.filter(
    ({ snapshot }) => snapshot.id === id,
  );
  let previous = baseline;
  let previousUpdate = updatesBefore.at(-1)?.update;
  for (const [index, response] of responses.entries()) {
    await herdr([
      "agent",
      "prompt",
      pane,
      `Reply exactly ${response}. Do not use tools or modify files.`,
      "--wait",
      "--timeout",
      "120000",
    ]);
    // Herdr --wait and idle alone can precede the result IPC frame.
    const latest = await until(
      id,
      (snapshot) =>
        (snapshot.resultRevision ?? 0) > (previous.resultRevision ?? 0) &&
        snapshot.sessionState === "idle",
    );
    assertResult(latest, "user_interaction", previous.resultRevision ?? 0);
    assert.equal(latest.result?.trim(), response);
    assert.ok((latest.resultUpdatedAt ?? 0) >= (previous.resultUpdatedAt ?? 0));
    assert.deepEqual(managedState(latest), managedState(baseline));
    assert.equal(latest.runtimeSessionId, baseline.runtimeSessionId);
    assert.equal(latest.terminalId, baseline.terminalId);
    assert.equal(latest.viewId, baseline.viewId);
    assert.equal(
      completions.filter((snapshot) => snapshot.id === id).length,
      completionCount,
    );
    const updates = sessionUpdates.filter(({ snapshot }) => snapshot.id === id);
    assert.equal(updates.length, updatesBefore.length + index + 1);
    const callback = updates.at(-1);
    assert.ok(callback);
    assert.equal(callback.update.type, "session_update");
    assert.ok(callback.update.interactionId);
    assert.ok(Number.isSafeInteger(callback.update.sequence));
    assert.ok(callback.update.sequence > (previousUpdate?.sequence ?? 0));
    assert.notEqual(
      callback.update.interactionId,
      previousUpdate?.interactionId,
    );
    assert.equal(callback.update.outcome, "completed");
    assert.equal(callback.update.response.trim(), response);
    assert.notEqual(callback.update.truncated, true);
    assert.equal(callback.update.error, undefined);
    assert.equal(latest.truncated, callback.update.truncated === true);
    assert.equal(callback.snapshot.result, latest.result);
    assert.equal(callback.snapshot.resultRevision, latest.resultRevision);
    assert.equal(callback.snapshot.resultSource, "user_interaction");
    assert.equal(callback.snapshot.resultUpdatedAt, latest.resultUpdatedAt);
    assert.equal(callback.snapshot.resultOutcome, callback.update.outcome);
    assert.equal(callback.snapshot.resultError, callback.update.error);
    assert.deepEqual(managedState(callback.snapshot), managedState(baseline));
    console.log(
      JSON.stringify({
        check: "native-session-update",
        runtime: latest.runtime,
        round: latest.round,
        result: latest.result,
        resultRevision: latest.resultRevision,
        interactionId: callback.update.interactionId,
        sequence: callback.update.sequence,
      }),
    );
    previous = latest;
    previousUpdate = callback.update;
  }
  return previous;
}
try {
  const pi = manager.spawn({
    runtime: "pi",
    cwd,
    prompt:
      "Reply with exactly PI_RUNTIME_OK. Do not use tools or modify files.",
    description: "Live Pi regression",
  });
  assert.match((await completed(pi.id)).result ?? "", /PI_RUNTIME_OK/);
  await manager.remove(pi.id);

  // Retain a real Pi TUI: native A -> B replaces the result without a new round.
  const retainedPi = manager.spawn({
    runtime: "pi",
    keepAlive: true,
    cwd,
    prompt: "Reply exactly PI_RETAINED_OK. Do not use tools or modify files.",
    description: "Live retained Pi dialogue",
  });
  const piFirst = await completed(retainedPi.id);
  assert.equal(piFirst.result?.trim(), "PI_RETAINED_OK");
  assert.ok(piFirst.runtimeSessionId);
  const piView = await manager.openView(retainedPi.id);
  assert.ok(piView);
  const piPane = rootPanes.get(retainedPi.id);
  assert.ok(piPane);
  const piNative = await nativeDialogue(
    retainedPi.id,
    piPane,
    manager.get(retainedPi.id),
    ["NATIVE_PI_A", "NATIVE_PI_B"],
  );
  assert.equal(manager.get(retainedPi.id).result?.trim(), "NATIVE_PI_B");
  // Managed continuation shares the retained history and restores managed source.
  manager.resume(retainedPi.id, {
    prompt: "Reply exactly PI_RESUMED_OK. Do not use tools or modify files.",
  });
  const piSecond = await completed(retainedPi.id, piNative.resultRevision);
  assert.equal(piSecond.result?.trim(), "PI_RESUMED_OK");
  assert.equal(piSecond.round, 2);
  assert.equal(piSecond.turnCount, 1);
  assert.equal(piSecond.runtimeSessionId, piFirst.runtimeSessionId);
  assert.equal(
    sessionUpdates.filter(({ snapshot }) => snapshot.id === retainedPi.id)
      .length,
    2,
  );
  await manager.closeView(retainedPi.id);
  await manager.remove(retainedPi.id);

  const secret = `MEMORY_${randomUUID().replaceAll("-", "")}`;
  const codex = manager.spawn({
    runtime: "codex",
    keepAlive: true,
    cwd,
    prompt: `Remember this key for this session: ${secret}. Reply exactly CODEX_RUNTIME_OK. Do not use tools or modify files.`,
    description: "Live Codex task",
  });
  const first = await completed(codex.id);
  assert.match(first.result ?? "", /CODEX_RUNTIME_OK/);
  assert.ok(first.runtimeSessionId);
  manager.resume(codex.id, {
    prompt:
      "Reply with exactly the key I asked you to remember earlier. Do not use tools.",
  });
  const second = await completed(codex.id, first.resultRevision);
  assert.equal(second.round, 2);
  assert.equal(second.result?.trim(), secret);
  assert.equal(second.runtimeSessionId, first.runtimeSessionId);
  assert.equal(second.turnCount, 1);

  manager.resume(codex.id, {
    prompt:
      "Use a shell tool to run sleep 60. After the command finishes, reply exactly BEFORE_STEER. Do not modify files.",
  });
  await until(
    codex.id,
    (snapshot) => snapshot.status === "running" && (snapshot.toolUses ?? 0) > 0,
  );
  const runningView = await manager.openView(codex.id);
  assert.ok(runningView);
  const runningPane = rootPanes.get(codex.id);
  assert.ok(runningPane);
  await readyCodexPane(runningPane);
  assert.equal(
    manager.get(codex.id).status,
    "running",
    JSON.stringify(manager.get(codex.id)),
  );
  assert.match(
    await herdr([
      "pane",
      "read",
      runningPane,
      "--source",
      "recent-unwrapped",
      "--lines",
      "100",
    ]),
    /Codex|codex|sleep/,
  );
  // Native input steers the same managed turn; its result remains managed.
  await herdr([
    "agent",
    "prompt",
    runningPane,
    "Replace the final response: reply exactly AFTER_STEER instead of BEFORE_STEER.",
    "--wait",
    "--timeout",
    "120000",
  ]);
  const steered = await completed(codex.id, second.resultRevision);
  assert.match(steered.result ?? "", /AFTER_STEER/);
  assert.equal(steered.round, 3);
  assert.equal(
    sessionUpdates.filter(({ snapshot }) => snapshot.id === codex.id).length,
    0,
  );
  console.log(
    JSON.stringify({ check: "running-native-view", viewId: runningView.id }),
  );
  await manager.closeView(codex.id);
  await herdr(["pane", "send-keys", runningPane, "ctrl+c"]);
  await new Promise((resolve) => setTimeout(resolve, 300));
  await herdr(["pane", "send-keys", runningPane, "ctrl+c"]);
  await new Promise((resolve) => setTimeout(resolve, 1200));

  manager.resume(codex.id, {
    prompt:
      "Use a shell tool to run sleep 60. Wait for it to finish before replying CANCEL_TOO_LATE. Do not modify files.",
  });
  await until(
    codex.id,
    (snapshot) => snapshot.status === "running" && (snapshot.toolUses ?? 0) > 0,
  );
  const stoppedAt = Date.now();
  manager.stop(codex.id);
  const stopped = await until(
    codex.id,
    (snapshot) => snapshot.status === "stopped",
    20_000,
  );
  // Cancellation can settle without a reply: empty responses retain the latest
  // nonempty result and revision, unlike the native replies checked above.
  if (stopped.resultRevision === steered.resultRevision) {
    assert.deepEqual(resultMetadata(stopped), resultMetadata(steered));
  } else {
    assertResult(stopped, "managed", steered.resultRevision ?? 0, "aborted");
  }
  assert.equal(stopped.round, 4);
  assert.equal(
    completions.filter((snapshot) => snapshot.id === codex.id).length,
    4,
  );
  assert.equal(
    sessionUpdates.filter(({ snapshot }) => snapshot.id === codex.id).length,
    0,
  );
  assert.ok(Date.now() - stoppedAt < 20_000);
  assert.equal(stopped.sessionState, "idle");
  assert.equal(stopped.runtimeSessionId, first.runtimeSessionId);
  console.log(
    JSON.stringify({
      check: "cancel-confirmed",
      round: stopped.round,
      status: stopped.status,
    }),
  );

  const view = await manager.openView(codex.id);
  assert.ok(view);
  const pane = rootPanes.get(codex.id);
  assert.ok(pane);
  await readyCodexPane(pane);
  const readPane = () =>
    herdr([
      "pane",
      "read",
      pane,
      "--source",
      "recent-unwrapped",
      "--lines",
      "100",
    ]);
  assert.match(await readPane(), /Codex|codex|MEMORY_/);
  console.log(
    JSON.stringify({
      check: "native-view",
      pane,
      viewId: manager.get(codex.id).viewId,
    }),
  );

  // Native A -> B updates the latest result, not managed rounds or their stats.
  const native = await nativeDialogue(codex.id, pane, manager.get(codex.id), [
    "NATIVE_CODEX_OK",
    "NATIVE_CODEX_B",
  ]);
  assert.match(await readPane(), /NATIVE_CODEX_B/);
  assert.equal(manager.get(codex.id).result?.trim(), "NATIVE_CODEX_B");
  assert.equal(manager.get(codex.id).round, 4);
  await manager.closeView(codex.id);
  assert.equal(manager.get(codex.id).viewId, undefined);
  manager.resume(codex.id, {
    prompt: "This must not be submitted while the native TUI is alive.",
  });
  const rejected = await until(
    codex.id,
    (snapshot) => snapshot.status === "error",
  );
  assert.match(rejected.error ?? "", /native Codex TUI/);
  assert.equal(manager.get(codex.id).sessionState, "idle");
  assert.deepEqual(resultMetadata(rejected), resultMetadata(native));
  assert.equal(
    completions.filter((snapshot) => snapshot.id === codex.id).length,
    5,
  );
  assert.equal(
    sessionUpdates.filter(({ snapshot }) => snapshot.id === codex.id).length,
    2,
  );
  console.log(
    JSON.stringify({
      check: "native-ownership-and-detach",
      status: rejected.status,
    }),
  );

  await herdr(["pane", "send-keys", pane, "ctrl+c"]);
  await new Promise((resolve) => setTimeout(resolve, 300));
  await herdr(["pane", "send-keys", pane, "ctrl+c"]);
  await new Promise((resolve) => setTimeout(resolve, 1200));
  const beforeFinal = manager.get(codex.id);
  assert.deepEqual(resultMetadata(beforeFinal), resultMetadata(native));
  manager.resume(codex.id, {
    prompt:
      "Reply with exactly the remembered key from the beginning. Do not use tools.",
  });
  const final = await completed(codex.id, beforeFinal.resultRevision);
  assert.equal(final.round, 6);
  assert.equal(
    sessionUpdates.filter(({ snapshot }) => snapshot.id === codex.id).length,
    2,
  );
  assert.equal(final.result?.trim(), secret);
  assert.equal(final.runtimeSessionId, first.runtimeSessionId);
  console.log("HERDR_LIVE_OK");
} finally {
  await manager.close();
  await rm(cwd, { recursive: true, force: true });
}
