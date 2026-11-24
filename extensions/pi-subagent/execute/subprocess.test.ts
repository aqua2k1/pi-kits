import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { useAgentDir } from "../../../tests/helpers/agent-dir.ts";
import { readSessionSnapshot } from "./index.ts";
import {
  createSubprocessExecutor,
  formatRpcSendCommand,
  parseRpcSettlementLine,
} from "./subprocess.ts";

test("formatRpcSendCommand and parseRpcSettlementLine are pure protocol functions", () => {
  assert.deepEqual(JSON.parse(formatRpcSendCommand("Inspect files")), {
    type: "prompt",
    message: "Inspect files",
    streamingBehavior: "followUp",
  });
  assert.deepEqual(
    JSON.parse(formatRpcSendCommand("Focus on index.ts", { if: "working" })),
    {
      type: "steer",
      message: "Focus on index.ts",
    },
  );

  assert.equal(
    parseRpcSettlementLine('{"type":"tool_execution_start"}'),
    undefined,
  );
  assert.deepEqual(
    parseRpcSettlementLine('{"type":"agent_settled","outcome":"completed"}'),
    { alive: true, state: "done" },
  );
  assert.deepEqual(
    parseRpcSettlementLine('{"type":"agent_settled","aborted":true}'),
    { alive: true, state: "idle" },
  );
  assert.deepEqual(
    parseRpcSettlementLine(
      '{"type":"response","command":"prompt","success":false,"error":"bad prompt"}',
    ),
    { alive: true, state: "error", message: "bad prompt" },
  );
});

test("subprocess executor runs real process over stdio RPC and reads persisted sessionPath", async (t) => {
  useAgentDir(t);
  const session = SessionManager.create("/tmp", undefined, {
    id: "subprocess-read-test",
  });
  session.appendMessage({
    role: "user",
    content: "Inspect files",
    timestamp: 1,
  });
  session.appendMessage({
    role: "assistant",
    content: [
      { type: "toolCall", id: "t1", name: "read", arguments: {} },
      { type: "text", text: "Found 2 issues" },
    ],
    provider: "openai",
    model: "gpt-5",
    usage: { input: 5, output: 10, cacheWrite: 0 },
    timestamp: 2,
  } as unknown as Parameters<SessionManager["appendMessage"]>[0]);
  const sessionFile = session.getSessionFile();
  assert.ok(sessionFile);
  t.after(() => rmSync(sessionFile, { force: true }));

  // Pure function readSessionSnapshot test
  const snapshot = readSessionSnapshot(sessionFile);
  assert.equal(snapshot.text, "Found 2 issues");
  assert.equal(snapshot.model, "openai/gpt-5");

  // End-to-end stateless subprocess lifecycle with a minimal node echo script
  const executor = createSubprocessExecutor({ env: process.env });
  const script = `
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (d) => {
      if (d.includes('"prompt"')) {
        process.stdout.write('{"type":"agent_settled","outcome":"completed"}\\n');
      }
    });
  `;
  const handle = await executor.start({
    agentId: "sub-1",
    cwd: "/tmp",
    sessionPath: sessionFile,
    argv: [process.execPath, "-e", script],
    env: {},
  });

  assert.deepEqual(await executor.inspect(handle), { alive: true });
  await executor.send(handle, "Inspect files");
  assert.deepEqual(await executor.wait(handle), { alive: true, state: "done" });
  assert.equal((await executor.read(handle)).text, "Found 2 issues");

  await executor.destroy(handle);
  assert.deepEqual(await executor.inspect(handle), { alive: false });
});
