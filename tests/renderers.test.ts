import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type ExtensionAPI,
  type ExtensionToolContext,
  keyHint,
  keyText,
  type MessageRenderer,
  type Theme,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import askExtension from "../extensions/pi-ask/index.ts";
import openExtension from "../extensions/pi-open/index.ts";
import type { Executor } from "../extensions/pi-subagent/execute/index.ts";
import { registerSubagents } from "../extensions/pi-subagent/index.ts";
import { useAgentDir } from "./helpers/agent-dir.ts";

const theme = {
  fg: (_color: string, value: string) => value,
  bg: (_color: string, value: string) => value,
  bold: (value: string) => value,
} as Theme;
function registrations() {
  const tools = new Map<string, ToolDefinition>();
  const messages = new Map<string, MessageRenderer>();
  const pi = {
    registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
    registerMessageRenderer: (type: string, renderer: MessageRenderer) =>
      messages.set(type, renderer),
    registerCommand() {},
    on() {},
  } as unknown as ExtensionAPI;
  return { pi, tools, messages };
}
function rendered(
  tool: ToolDefinition,
  details: unknown,
  text = "Full result",
  expanded = false,
  isPartial = false,
  isError = false,
) {
  assert.ok(tool.renderResult);
  return tool
    .renderResult(
      { content: [{ type: "text", text }], details },
      { expanded, isPartial },
      theme,
      { isError } as Parameters<NonNullable<ToolDefinition["renderResult"]>>[3],
    )
    .render(200)
    .join("\n");
}

test("all four public tools and the completion message register shared-style renderers", async (t) => {
  useAgentDir(t);
  const h = registrations();
  openExtension(h.pi);
  askExtension(h.pi);
  registerSubagents(h.pi, {} as Executor);
  assert.equal(h.tools.size, 4);
  for (const tool of h.tools.values()) {
    assert.equal(typeof tool.renderCall, "function", tool.name);
    assert.equal(typeof tool.renderResult, "function", tool.name);
  }
  assert.equal(typeof h.messages.get("subagent-notification"), "function");
  const notification = h.messages.get("subagent-notification");
  assert.ok(notification);
  const details = {
    description: "Task A",
    status: "completed",
    result: "Done",
    id: "private-id",
    sessionPath: "/private/session",
  };
  const content = JSON.stringify(details, null, 2);
  const message = Object.freeze({
    role: "custom" as const,
    timestamp: 0,
    customType: "subagent-notification",
    display: true,
    content,
    details: Object.freeze(details),
  });
  const compact =
    notification(
      message,
      { expanded: false, outputPad: 0, keyText, keyHint },
      theme,
    )
      ?.render(200)
      .join("\n") ?? "";
  assert.equal(
    compact
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .join("\n"),
    "✓ Subagent · — · Task A · private-id · completed\nDone",
  );
  const full =
    notification(
      message,
      { expanded: true, outputPad: 0, keyText, keyHint },
      theme,
    )
      ?.render(200)
      .join("\n") ?? "";
  assert.match(full, /private-id/);
  assert.equal(message.content, content);
  assert.equal(
    full.split("private-id").length - 1,
    1,
    "Do not duplicate JSON content and details",
  );
});

test("tool summaries retain questions and errors", async (t) => {
  useAgentDir(t);
  const h = registrations();
  openExtension(h.pi);
  askExtension(h.pi);
  registerSubagents(h.pi, {} as Executor);
  const get = (name: string) => {
    const tool = h.tools.get(name);
    assert.ok(tool);
    return tool;
  };
  assert.match(
    rendered(get("ask_user_question"), {
      answers: [{ answer: "Option A" }],
      cancelled: false,
    }),
    /answered · 1 answers\nOption A/,
  );
  assert.match(
    rendered(get("ask_user_question"), { answers: [], cancelled: true }),
    /^cancelled/,
  );
  const open = get("open");
  const result = await open.execute(
    "id",
    { target: "" },
    undefined,
    undefined,
    { cwd: "/tmp" } as ExtensionToolContext,
  );
  assert.match(rendered(open, result.details), /^error\nUsage:/);
});
