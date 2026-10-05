import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AgentSnapshot, SubagentManager } from "../manager.ts";
import { HerdrAdapter, runHerdr } from "../mux/herdr.ts";

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
const manager = new SubagentManager(adapter, {
  maxConcurrent: 1,
  startupTimeoutMs: 60_000,
  runtimeExecutables: { codex: process.env.PI_KITS_CODEX_BIN },
});
async function herdr(argv: string[]) {
  const result = await runHerdr(binary, argv, {
    timeoutMs: 150_000,
    maxOutputBytes: 256 * 1024,
  });
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
async function completed(id: string) {
  const result = await until(id, (snapshot) => snapshot.status === "completed");
  console.log(
    JSON.stringify({
      check: "completed",
      runtime: result.runtime,
      round: result.round,
      result: result.result,
      toolUses: result.toolUses,
      totalTokens: result.totalTokens,
    }),
  );
  return result;
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
  const second = await completed(codex.id);
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
  await new Promise((resolve) => setTimeout(resolve, 2000));
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
  assert.match((await completed(codex.id)).result ?? "", /AFTER_STEER/);
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

  const savedResult = stopped.result;
  const view = await manager.openView(codex.id);
  assert.ok(view);
  const pane = rootPanes.get(codex.id);
  assert.ok(pane);
  await new Promise((resolve) => setTimeout(resolve, 2500));
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

  // Native input must not be attributed to a managed round.
  await herdr([
    "agent",
    "prompt",
    pane,
    "Reply exactly NATIVE_CODEX_OK. Do not use tools.",
    "--wait",
    "--timeout",
    "120000",
  ]);
  await until(codex.id, (snapshot) => snapshot.sessionState === "idle");
  assert.match(await readPane(), /NATIVE_CODEX_OK/);
  assert.equal(manager.get(codex.id).result, savedResult);
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
  manager.resume(codex.id, {
    prompt:
      "Reply with exactly the remembered key from the beginning. Do not use tools.",
  });
  const final = await completed(codex.id);
  assert.equal(final.result?.trim(), secret);
  assert.equal(final.runtimeSessionId, first.runtimeSessionId);
  console.log("HERDR_LIVE_OK");
} finally {
  await manager.close();
  await rm(cwd, { recursive: true, force: true });
}
