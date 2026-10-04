import assert from "node:assert/strict";
import { test } from "node:test";
import {
  initTheme,
  type Theme,
  type ToolDefinition,
  ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";
import {
  stripTerminalSequences,
  type TUI,
  visibleWidth,
} from "@earendil-works/pi-tui";
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
  displayName: "Reviewer",
  model: "provider/model-id",
  modelName: "Model Name",
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

test("collapsed subagent output shows shared identity header and one preview line", () => {
  const lines = render(snapshot).render(200);
  assert.equal(lines.length, 2);
  assert.equal(
    lines[0],
    "✓ Reviewer · Model Name · LIVE_CODEMODE_SUCCESS · 07ea6fc5 · completed",
  );
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

test("headers fall back to type, model ID and generic agent name", () => {
  const typed = { ...snapshot, displayName: undefined, modelName: undefined };
  assert.match(
    render(typed).render(200)[0],
    /long-config-name · provider\/model-id/,
  );
  assert.match(
    render({ ...typed, subagentType: undefined, model: undefined }).render(
      200,
    )[0],
    /Subagent · —/,
  );
});

test("interactive state is visible without replacing the completed task result", () => {
  const lines = render({ ...snapshot, sessionState: "interactive" }).render(
    200,
  );
  assert.match(lines[0], /completed · interactive/);
  assert.match(lines[1], /packageName/);
});

test("result rows retain the unified identity header", () => {
  const component = renderSubagentResult(
    { content: [], details: snapshot },
    { expanded: false, isPartial: false },
    theme,
    { args: { description: snapshot.description } } as RenderContext,
  );
  assert.equal(
    component.render(200)[0],
    "✓ Reviewer · Model Name · LIVE_CODEMODE_SUCCESS · 07ea6fc5 · completed",
  );
});

test("errors, empty results and truncation remain truthful without JSON noise", () => {
  assert.deepEqual(render({ ...snapshot, result: "" }).render(80), [
    "✓ Reviewer · Model Name · LIVE_CODEMODE_SUCCESS · 07ea6fc5 · completed",
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

test("tool calls show model and short ID but hide prompts until expanded", () => {
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
  assert.deepEqual(collapsed, [
    "◦ Subagent · a/model · Review · 07ea6fc5 · queued",
  ]);
  assert.ok(!collapsed.join("\n").includes(args.prompt));
  const expanded = renderer(args, theme, { expanded: true } as RenderContext)
    .render(100)
    .join("\n");
  assert.match(expanded, /Private task prompt/);
  assert.ok(expanded.includes(snapshot.id));
});

test("starting results do not re-enter rendering or duplicate the call header", () => {
  const starting = { ...snapshot, status: "starting" as const, result: "" };
  let invalidations = 0;
  const state = {};
  const context = {
    expanded: false,
    executionStarted: true,
    state,
    invalidate() {
      invalidations += 1;
    },
  } as RenderContext;
  const call = subagentCallRenderer("Subagent")(
    { description: starting.description },
    theme,
    context,
  );
  assert.equal(call.render(200).length, 1);
  for (let i = 0; i < 3; i++) {
    // Pi supplies separate contexts sharing the same state object and creates
    // the call component before invoking the result renderer.
    const result = renderSubagentResult(
      { content: [], details: { ...starting } },
      { expanded: false, isPartial: false },
      theme,
      { ...context, state },
    );
    const lines = [...call.render(200), ...result.render(200)];
    assert.equal(lines.length, 1);
    assert.match(lines[0], /Reviewer · Model Name .* · starting$/);
  }
  assert.equal(
    invalidations,
    0,
    "Result rendering must not synchronously invalidate Pi's tool card",
  );
  const expanded = subagentCallRenderer("Subagent")(
    { prompt: "Private task prompt" },
    theme,
    { ...context, expanded: true },
  );
  assert.match(expanded.render(200).join("\n"), /Private task prompt/);
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
    assert.match(lines.join("\n"), /Reviewer · Model Name .* · starting/);
  }
});

test("result owns the identity header; calls without results use manager identity", () => {
  const context = {
    expanded: false,
    state: {},
    invalidate() {},
  } as RenderContext;
  renderSubagentResult(
    { content: [], details: snapshot },
    { expanded: false, isPartial: false },
    theme,
    context,
  );
  const renderer = subagentCallRenderer("Subagent");
  const expected =
    "✓ Reviewer · Model Name · LIVE_CODEMODE_SUCCESS · 07ea6fc5 · completed";
  assert.deepEqual(renderer({}, theme, context).render(200), []);
  const lookup = subagentCallRenderer("Subagent result", () => snapshot);
  assert.equal(
    lookup({ agent_id: snapshot.id }, theme, {
      expanded: false,
    } as RenderContext).render(200)[0],
    expected,
  );
});
