import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { useAgentDir } from "../../tests/helpers/agent-dir.ts";
import { captureParentSession, createClonedSession } from "./clone.ts";

test("captureParentSession freezes the current branch and createClonedSession omits pending tool calls", (t) => {
  useAgentDir(t);
  const parent = SessionManager.inMemory("/tmp");
  parent.appendMessage({
    role: "user",
    content: "Inspect project",
    timestamp: 1,
  });
  parent.appendMessage({
    role: "assistant",
    content: [
      { type: "text", text: "Calling subagent" },
      { type: "toolCall", id: "pending-call", name: "subagent", arguments: {} },
    ],
    timestamp: 2,
  } as unknown as Parameters<SessionManager["appendMessage"]>[0]);

  const snapshot = captureParentSession(parent);
  assert.ok(snapshot);
  parent.appendMessage({
    role: "user",
    content: "After snapshot",
    timestamp: 3,
  });

  const file = createClonedSession(snapshot, "/tmp", "subagent-clone-test");
  try {
    const cloned = SessionManager.open(file);
    assert.equal(cloned.getSessionId(), "subagent-clone-test");
    const messages = cloned.buildSessionProjection().messages;
    assert.equal(messages.length, 2);
    const assistant = messages[1];
    assert.equal(assistant.role, "assistant");
    if (assistant.role === "assistant" && Array.isArray(assistant.content)) {
      assert.equal(
        assistant.content.some((block) => block.type === "toolCall"),
        false,
      );
    }
  } finally {
    rmSync(file, { force: true });
  }
});
