import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  ExtensionAPI,
  ExtensionToolContext,
  MessageRenderer,
  Theme,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import askExtension from "../extensions/ask-user-question/index.ts";
import openExtension from "../extensions/open/index.ts";
import { registerSubagents } from "../extensions/subagent/index.ts";
import type { MuxAdapter } from "../extensions/subagent/mux.ts";
import webExtension from "../extensions/web-kits/index.ts";
import { useAgentDir } from "./helpers/agent-dir.ts";

const theme = {
  fg: (_color: string, value: string) => value,
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

test("all ten public tools and the completion message register shared-style renderers", async (t) => {
  useAgentDir(t);
  const h = registrations();
  openExtension(h.pi);
  askExtension(h.pi);
  registerSubagents(h.pi, {} as MuxAdapter);
  await webExtension(h.pi, { env: {}, cleanupExpiredSpools: async () => {} });
  assert.equal(h.tools.size, 10);
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
    notification(message, { expanded: false, outputPad: 0 }, theme)
      ?.render(200)
      .join("\n") ?? "";
  assert.equal(compact, "Subagent · Task A · completed\nDone");
  assert.ok(!compact.includes("private-id"));
  const full =
    notification(message, { expanded: true, outputPad: 0 }, theme)
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

test("tool summaries retain questions, search counts, saved fetch details and errors", async (t) => {
  useAgentDir(t);
  const h = registrations();
  openExtension(h.pi);
  askExtension(h.pi);
  registerSubagents(h.pi, {} as MuxAdapter);
  await webExtension(h.pi, { env: {}, cleanupExpiredSpools: async () => {} });
  const get = (name: string) => {
    const tool = h.tools.get(name);
    assert.ok(tool);
    return tool;
  };
  assert.match(
    rendered(get("list_subagent_types"), {
      agents: [
        { name: "Explore", enabled: true },
        { name: "Old", enabled: false },
      ],
    }),
    /2 types\nExplore · Old \(disabled\)/,
  );
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
  const search = {
    resultCount: 1,
    results: [{ title: "Result title", url: "https://example.test" }],
    truncated: true,
  };
  assert.match(
    rendered(get("web_search"), search),
    /completed · 1 results\nResult title\n\[Result truncated\]/,
  );
  assert.match(
    rendered(get("web_search"), { resultCount: 0, results: [] }),
    /No results/,
  );
  const fetch = {
    title: "Page",
    fullOutputPath: "/private/fetch.txt",
    finalUrl: "https://example.test",
    source: "native-http",
  };
  assert.equal(rendered(get("web_fetch"), fetch), "completed\nPage");
  assert.match(
    rendered(get("web_fetch"), fetch, "Full fetched body", true),
    /Full fetched body/,
  );
  assert.match(
    rendered(get("web_fetch"), fetch, "Full fetched body", true),
    /\/private\/fetch.txt/,
  );
  assert.equal(
    rendered(get("web_fetch"), undefined, "Network failed", false, false, true),
    "error\nNetwork failed",
  );
  assert.equal(
    rendered(get("web_fetch"), undefined, "Fetching...", false, true),
    "running\nFetching...",
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
