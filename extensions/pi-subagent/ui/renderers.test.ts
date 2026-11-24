import assert from "node:assert/strict";
import { test } from "node:test";
import {
  initTheme,
  keyHint,
  keyText,
  type Theme,
  type ToolDefinition,
  ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";
import {
  stripTerminalSequences,
  type TUI,
  visibleWidth,
} from "@earendil-works/pi-tui";
import type { AgentSnapshot } from "../manager.ts";
import {
  renderSubagentNotification,
  renderSubagentResult,
  subagentCallRenderer,
} from "./renderers.ts";

type RenderContext = Parameters<NonNullable<ToolDefinition["renderResult"]>>[3];
const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as Theme;
const snapshot: AgentSnapshot = Object.freeze({
  id: "sub-1",
  description: "LIVE_CODEMODE_SUCCESS",
  status: "completed",
  subagentType: "long-config-name",
  displayName: "Reviewer",
  model: "provider/model-id",
  sessionPath: "/private/session.jsonl",
  createdAt: 1791090566583,
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

test("collapsed subagent output shows shared identity header and one preview line", () => {
  const lines = render(snapshot).render(200);
  assert.equal(lines.length, 2);
  assert.equal(
    lines[0],
    "✓ Reviewer · provider/model-id · LIVE_CODEMODE_SUCCESS · sub-1 · completed",
  );
  assert.match(lines[1], /packageName/);
  const expanded = render(snapshot, true).render(200).join("\n");
  assert.match(expanded, /createdAt/);
  assert.ok(expanded.includes(snapshot.id));
});

test("native notifications show latest reply revision and independent outcome", () => {
  const message = {
    role: "custom" as const,
    customType: "subagent-notification",
    content: "Latest reply",
    display: true,
    timestamp: 123,
    details: {
      ...snapshot,
      status: "error" as const,
      error: "Old managed error",
      result: "New native reply",
      resultRevision: 2,
      sessionUpdate: {
        interactionId: "native-1",
        outcome: "completed",
        hasReply: true,
      },
    },
  };
  const rendered = renderSubagentNotification(
    message,
    { expanded: false, outputPad: 0, keyText, keyHint },
    theme,
  );
  assert.ok(rendered);
  const lines = rendered.render(300);
  assert.match(lines.join("\n"), /user interaction completed · reply #2/);
  assert.match(lines.join("\n"), /New native reply/);
});

test("headers fall back to type, model ID and generic agent name", () => {
  const typed = { ...snapshot, displayName: undefined };
  assert.match(
    render(typed).render(200)[0],
    /long-config-name · provider\/model-id/,
  );
  assert.match(
    render({
      ...typed,
      subagentType: undefined,
      model: undefined,
    }).render(200)[0],
    /Subagent · —/,
  );
});

test("tool calls show short ID and derive fallback title from prompt or action", () => {
  const args = {
    description: "Review",
    prompt: "Private task prompt",
    id: snapshot.id,
  };
  const renderer = subagentCallRenderer("Subagent");
  const collapsed = renderer(args, theme, {
    expanded: false,
  } as RenderContext).render(80);
  assert.deepEqual(collapsed, ["◦ Subagent · — · Review · sub-1 · queued"]);
  assert.ok(!collapsed.join("\n").includes(args.prompt));

  const ctlRenderer = subagentCallRenderer("Subagent control");
  const ctlCollapsed = ctlRenderer({ id: "sub-1", action: "wait" }, theme, {
    expanded: false,
  } as RenderContext).render(80);
  assert.deepEqual(ctlCollapsed, [
    "◦ Subagent · — · Subagent control (wait) · sub-1 · queued",
  ]);
});

test("Pi tool card keeps exactly one starting header across repeated updates", () => {
  initTheme("dark", false);
  const card = new ToolExecutionComponent(
    "subagent",
    "test-call",
    { description: snapshot.description },
    {},
    {
      renderCall: subagentCallRenderer("Subagent"),
      renderResult: renderSubagentResult,
    },
    { requestRender() {} } as unknown as TUI,
    process.cwd(),
  );
  card.markExecutionStarted();
  for (let i = 0; i < 3; i++) {
    card.updateResult({
      content: [],
      details: { ...snapshot, status: "starting", result: "" },
      isError: false,
    });
    card.invalidate();
    const lines = card.render(200).map(stripTerminalSequences);
    assert.equal(
      lines.filter((line) => line.includes(snapshot.description)).length,
      1,
    );
  }
});

test("collapsed output is width bounded and terminal-safe", () => {
  const unsafe = {
    ...snapshot,
    description: "任务\x1b[31m\n标题",
    result: "value\x1b[2J\x9b31m\u2028next",
  };
  for (const width of [0, 1, 8, 40, 80]) {
    const lines = render(unsafe).render(width);
    for (const line of lines) {
      assert.ok(visibleWidth(line) <= width);
    }
  }
});
