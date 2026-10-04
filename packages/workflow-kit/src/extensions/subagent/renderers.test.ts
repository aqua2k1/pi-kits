import assert from "node:assert/strict";
import { test } from "node:test";
import type { Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import type { AgentSnapshot } from "./manager.ts";
import { renderSubagentResult, subagentCallRenderer } from "./renderers.ts";

type RenderContext = Parameters<NonNullable<ToolDefinition["renderResult"]>>[3];
const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as Theme;
const snapshot: AgentSnapshot = Object.freeze({
  id: "07ea6fc5-4c49-4759-afb3-7dd643bb5cd8",
  description: "LIVE_CODEMODE_SUCCESS",
  status: "completed",
  subagentType: "long-config-name",
  agentPath: "/private/agents/config.md",
  sessionPath: "/private/session.jsonl",
  createdAt: 1791090566583,
  turnCount: 2,
  toolUses: 2,
  result: 'Script completed\nOutput:\n{"packageName":"pi-kits"}',
});
function render(
  details: AgentSnapshot | undefined,
  expanded = false,
  isError = false,
  text = "",
) {
  return renderSubagentResult(
    { content: [{ type: "text", text }], details },
    { expanded, isPartial: false },
    theme,
    { isError } as RenderContext,
  );
}

test("collapsed subagent output shows only task, status and one preview line", () => {
  const lines = render(snapshot).render(200);
  assert.equal(lines.length, 2);
  assert.equal(lines[0], "LIVE_CODEMODE_SUCCESS · completed");
  assert.match(lines[1], /packageName/);
  for (const hidden of [
    snapshot.id,
    snapshot.agentPath,
    snapshot.sessionPath,
    "createdAt",
    "turnCount",
    "toolUses",
    "long-config-name",
  ]) {
    assert.ok(hidden);
    assert.ok(!lines.join("\n").includes(hidden));
  }
  const expanded = render(snapshot, true).render(200).join("\n");
  assert.match(expanded, /createdAt/);
  assert.ok(expanded.includes(snapshot.id));
  assert.ok(snapshot.agentPath);
  assert.ok(expanded.includes(snapshot.agentPath));
  assert.equal(
    snapshot.result,
    'Script completed\nOutput:\n{"packageName":"pi-kits"}',
  );
});

test("result rows do not repeat the task title already shown in the call", () => {
  const component = renderSubagentResult(
    { content: [], details: snapshot },
    { expanded: false, isPartial: false },
    theme,
    { args: { description: snapshot.description } } as RenderContext,
  );
  assert.equal(component.render(80)[0], "completed");
});

test("errors, empty results and truncation remain truthful without JSON noise", () => {
  assert.deepEqual(render({ ...snapshot, result: "" }).render(80), [
    "LIVE_CODEMODE_SUCCESS · completed",
  ]);
  const error = render({
    ...snapshot,
    status: "error",
    error: "Missing tool",
    result: "old result",
  }).render(80);
  assert.match(error[0], /error/);
  assert.equal(error[1], "Missing tool");
  assert.deepEqual(
    render(undefined, false, true, "Unknown subagent type").render(80),
    ["error", "Unknown subagent type"],
  );
  assert.match(
    render({ ...snapshot, truncated: true })
      .render(80)
      .join("\n"),
    /truncated/,
  );
});

test("collapsed output is width bounded and terminal-safe; expansion escapes controls", () => {
  const unsafe = {
    ...snapshot,
    description: "任务\x1b[31m\n标题",
    result: "value\x1b[2J\x9b31m\u2028next",
  };
  for (const width of [0, 1, 8, 40, 80]) {
    const lines = render(unsafe).render(width);
    for (const line of lines) {
      assert.ok(visibleWidth(line) <= width);
      const plain = stripTerminalSequences(line);
      assert.ok(!line.includes("\x1b[2J"));
      assert.ok(!line.includes("\x1b[31m"));
      for (const control of ["\x1b", "\x9b", "\n", "\u2028"]) {
        assert.ok(!plain.includes(control));
      }
    }
  }
  const full = render(unsafe, true).render(200).join("\n");
  for (const control of ["\x1b", "\x9b", "\u2028"]) {
    assert.ok(!full.includes(control));
  }
  assert.match(full, /\\u009b/);
});

test("tool calls hide prompts, IDs and model parameters until expanded", () => {
  const args = {
    description: "Review",
    prompt: "Private task prompt",
    model: "a/model",
    agent_id: snapshot.id,
  };
  const renderer = subagentCallRenderer("Subagent");
  const collapsed = renderer(args, theme, {
    expanded: false,
  } as RenderContext).render(80);
  assert.deepEqual(collapsed, ["Subagent · Review"]);
  const expanded = renderer(args, theme, { expanded: true } as RenderContext)
    .render(100)
    .join("\n");
  assert.match(expanded, /Private task prompt/);
  assert.ok(expanded.includes(snapshot.id));
});
