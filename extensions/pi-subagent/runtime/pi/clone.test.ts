import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { test } from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { useAgentDir } from "../../../../tests/helpers/agent-dir.ts";
import { captureParentSession, createClonedSession } from "./clone.ts";

function assistant(content: AssistantMessage["content"]): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "openai-responses",
    provider: "test",
    model: "test",
    stopReason: "toolUse",
    timestamp: 1,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}

function clone(parent: SessionManager, id = "subagent-clone-test") {
  const snapshot = captureParentSession(parent);
  assert.ok(snapshot);
  return SessionManager.open(
    createClonedSession(snapshot, parent.getCwd(), id),
  );
}

test("native clone preserves structured history, images, tool pairs and parent lineage without changing parent", (t) => {
  useAgentDir(t);
  const parent = SessionManager.create("/tmp/clone-project");
  parent.appendMessage({
    role: "user",
    content: [
      { type: "text", text: "Context secret" },
      { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
    ],
    timestamp: 1,
  });
  parent.appendMessage(
    assistant([
      {
        type: "toolCall",
        id: "read-1",
        name: "read",
        arguments: { path: "package.json" },
      },
    ]),
  );
  parent.appendMessage({
    role: "toolResult",
    toolCallId: "read-1",
    toolName: "read",
    content: [{ type: "text", text: "File contents" }],
    isError: false,
    timestamp: 2,
  });
  const original = readFileSync(parent.getSessionFile() ?? "", "utf8");
  const leaf = parent.getLeafId();
  const child = clone(parent);
  assert.notEqual(child.getSessionId(), parent.getSessionId());
  assert.equal(child.getHeader()?.parentSession, parent.getSessionFile());
  assert.deepEqual(
    child.buildSessionProjection().messages,
    parent.buildSessionProjection().messages,
  );
  assert.equal(statSync(child.getSessionFile() ?? "").mode & 0o777, 0o600);
  child.appendMessage({ role: "user", content: "Child only", timestamp: 3 });
  assert.equal(parent.getLeafId(), leaf);
  assert.equal(readFileSync(parent.getSessionFile() ?? "", "utf8"), original);
});

test("snapshot freezes the selected branch even if the parent changes before the worker starts", (t) => {
  useAgentDir(t);
  const parent = SessionManager.inMemory("/tmp/clone-project");
  const root = parent.appendMessage({
    role: "user",
    content: "Root",
    timestamp: 1,
  });
  parent.appendMessage({
    role: "user",
    content: "Abandoned branch",
    timestamp: 2,
  });
  parent.branch(root);
  parent.appendMessage({
    role: "user",
    content: "Chosen branch",
    timestamp: 3,
  });
  const snapshot = captureParentSession(parent);
  assert.ok(snapshot);
  parent.appendMessage({ role: "user", content: "Later input", timestamp: 4 });
  const child = SessionManager.open(
    createClonedSession(snapshot, parent.getCwd(), "subagent-frozen"),
  );
  const text = JSON.stringify(child.getEntries());
  assert.match(text, /Chosen branch/);
  assert.doesNotMatch(text, /Abandoned branch|Later input/);
  assert.equal(child.getHeader()?.parentSession, undefined);
});

test("compaction checkpoints, branch labels and context edits survive native cloning", (t) => {
  useAgentDir(t);
  const parent = SessionManager.inMemory("/tmp/clone-project");
  const old = parent.appendMessage({
    role: "user",
    content: "Old raw data",
    timestamp: 1,
  });
  const kept = parent.appendMessage({
    role: "user",
    content: "Private raw value",
    timestamp: 2,
  });
  parent.appendCompaction("Summary of older discussion", kept, 5000);
  parent.appendContextEdit(kept, { content: "Redacted replacement" });
  parent.appendLabelChange(kept, "checkpoint");
  const child = clone(parent);
  assert.equal(child.getLabel(kept), "checkpoint");
  const context = JSON.stringify(child.buildSessionProjection().messages);
  assert.match(context, /Summary of older discussion|Redacted replacement/);
  assert.doesNotMatch(context, /Private raw value|Old raw data/);
  assert.ok(
    child.getEntry(old),
    "Raw history is cloned, not converted to text",
  );
});

test("in-flight spawn calls are removed from projected context while completed sibling calls remain", (t) => {
  useAgentDir(t);
  const parent = SessionManager.inMemory("/tmp/clone-project");
  parent.appendMessage({ role: "user", content: "Delegate", timestamp: 1 });
  const calls = parent.appendMessage(
    assistant([
      { type: "text", text: "Launching worker" },
      { type: "toolCall", id: "complete", name: "read", arguments: {} },
      { type: "toolCall", id: "pending", name: "subagent", arguments: {} },
    ]),
  );
  parent.appendMessage({
    role: "toolResult",
    toolCallId: "complete",
    toolName: "read",
    content: [{ type: "text", text: "Done" }],
    isError: false,
    timestamp: 2,
  });
  const child = clone(parent);
  const context = JSON.stringify(child.buildSessionProjection().messages);
  assert.match(context, /complete/);
  assert.doesNotMatch(context, /pending/);
  assert.match(
    JSON.stringify(child.getEntry(calls)),
    /pending/,
    "Raw record is retained",
  );
  assert.match(
    JSON.stringify(parent.buildSessionProjection().messages),
    /pending/,
    "Parent is untouched",
  );
});

test("a thinking-only unresolved assistant is omitted rather than replayed as an empty tool turn", (t) => {
  useAgentDir(t);
  const parent = SessionManager.inMemory("/tmp/clone-project");
  parent.appendMessage({ role: "user", content: "Delegate", timestamp: 1 });
  parent.appendMessage(
    assistant([
      { type: "thinking", thinking: "Internal", thinkingSignature: "opaque" },
      { type: "toolCall", id: "pending", name: "subagent", arguments: {} },
    ]),
  );
  const child = clone(parent);
  assert.equal(
    child
      .buildSessionProjection()
      .messages.some((message) => message.role === "assistant"),
    false,
  );
});

test("snapshot uses JSONL-compatible extension metadata rather than requiring structuredClone-safe details", (t) => {
  useAgentDir(t);
  const parent = SessionManager.inMemory("/tmp/clone-project");
  parent.appendMessage({ role: "user", content: "Context", timestamp: 1 });
  parent.appendCustomEntry("extension_state", {
    value: "kept",
    helper: () => {},
  });
  const child = clone(parent);
  assert.match(JSON.stringify(child.getEntries()), /kept/);
});

test("empty parent history starts fresh instead of manufacturing a clone", () => {
  assert.equal(
    captureParentSession(SessionManager.inMemory("/tmp/clone-project")),
    undefined,
  );
});

test("large parent history is preserved without passing through the task IPC limit", (t) => {
  useAgentDir(t);
  const parent = SessionManager.inMemory("/tmp/clone-project");
  parent.appendMessage({
    role: "user",
    content: "x".repeat(100000),
    timestamp: 1,
  });
  const child = clone(parent);
  assert.deepEqual(
    child.buildSessionProjection().messages,
    parent.buildSessionProjection().messages,
  );
});
