import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import {
  type ExtensionAPI,
  type ExtensionCommandContext,
  initTheme,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import handoff from "./index.ts";
import { HANDOFF_INSTRUCTIONS, SECTIONS } from "./prompt.ts";
import {
  handoffId,
  handoffPath,
  metadataHeader,
  projectPath,
  readHandoff,
} from "./store.ts";

const BODY = `# Handoff\n\n${SECTIONS.map((section, index) => `## ${section}\n${index === 0 ? "修复剩余测试" : "无"}`).join("\n\n")}`;
let root: string;
let project: string;
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
before(async () => {
  root = await mkdtemp(join(tmpdir(), "pi-handoff-test-"));
  project = await projectPath(root);
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  initTheme("dark");
});
after(async () => {
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  await rm(root, { recursive: true, force: true });
});
const directory = () => join(root, "agent", "handoffs");

async function writeDocument(
  sessionId: string,
  documentProject = project,
  body = BODY,
) {
  await mkdir(directory(), { recursive: true });
  const id = handoffId(documentProject, sessionId);
  const path = handoffPath(directory(), id);
  const header = metadataHeader({
    id,
    sessionId,
    project: documentProject,
    title: "修复测试",
    updatedAt: new Date().toISOString(),
  });
  await writeFile(path, `${header}\n\n${body}\n`);
  return { id, path };
}

function harness(sessionId = "session-a") {
  const commands = new Map<
    string,
    Parameters<ExtensionAPI["registerCommand"]>[1]
  >();
  const renderers = new Map<
    string,
    Parameters<ExtensionAPI["registerMessageRenderer"]>[1]
  >();
  const messages: Parameters<ExtensionAPI["sendMessage"]>[] = [];
  const prompts: Parameters<ExtensionAPI["sendUserMessage"]>[] = [];
  const notices: string[] = [];
  let selection: string | undefined;
  let choices: string[] = [];
  const pi = {
    registerCommand: (
      name: string,
      command: Parameters<ExtensionAPI["registerCommand"]>[1],
    ) => commands.set(name, command),
    registerMessageRenderer: (
      name: string,
      renderer: Parameters<ExtensionAPI["registerMessageRenderer"]>[1],
    ) => renderers.set(name, renderer),
    sendMessage: (...args: Parameters<ExtensionAPI["sendMessage"]>) =>
      messages.push(args),
    sendUserMessage: (...args: Parameters<ExtensionAPI["sendUserMessage"]>) =>
      prompts.push(args),
  } as unknown as ExtensionAPI;
  // No model registry, fork, compact or registered tools: generation uses the current agent.
  const ctx = {
    cwd: root,
    hasUI: true,
    waitForIdle: async () => {},
    sessionManager: { getSessionId: () => sessionId, getLeafId: () => "leaf" },
    ui: {
      notify: (message: string) => notices.push(message),
      select: async (_title: string, labels: string[]) => {
        choices = labels;
        return selection === "first" ? labels[0] : selection;
      },
    },
  } as unknown as ExtensionCommandContext;
  handoff(pi);
  return {
    ctx,
    commands,
    renderers,
    messages,
    prompts,
    notices,
    run: (name: string, args = "") => commands.get(name)?.handler(args, ctx),
    setSelection: (value?: string) => {
      selection = value;
    },
    choices: () => choices,
  };
}

test("registers only two commands and the native message renderer", () => {
  const h = harness();
  assert.deepEqual([...h.commands.keys()], ["handoff", "handoff-open"]);
  assert.deepEqual([...h.renderers.keys()], ["pi-handoff"]);
});

test("handoff sends instructions to the current agent without generating or writing a document", async () => {
  const h = harness("current-agent");
  await h.run("handoff", "  open 是下一会话的重点  ");
  const id = handoffId(project, "current-agent");
  const path = handoffPath(directory(), id);
  assert.equal(h.prompts.length, 1);
  assert.equal(h.messages.length, 0);
  const [prompt, options] = h.prompts[0];
  assert.equal(options?.deliverAs, "followUp");
  assert.match(String(prompt), /open 是下一会话的重点/);
  assert.ok(String(prompt).includes(JSON.stringify(path)));
  assert.match(String(prompt), new RegExp(`/handoff-open ${id}`));
  assert.equal(await readHandoff(directory(), id), undefined);
  // The command must not claim the agent has already saved a document.
  assert.equal(h.notices.length, 0);
});

test("repeated handoff keeps the same ID and backs up manual edits before asking for revision", async () => {
  const { id, path } = await writeDocument(
    "updates",
    project,
    `${BODY}\n\n手动补充：先验证兼容性。`,
  );
  const raw = await readFile(path, "utf8");
  const h = harness("updates");
  await h.run("handoff");
  const prompt = String(h.prompts[0][0]);
  assert.match(prompt, new RegExp(id));
  assert.match(prompt, /读取磁盘最新内容/);
  assert.match(prompt, /保留手动调整/);
  assert.equal(await readFile(path, "utf8"), raw);
  const backups = (await readdir(directory())).filter(
    (name) => name.startsWith(`.${id}.`) && name.endsWith(".bak"),
  );
  assert.equal(backups.length, 1);
  assert.equal(await readFile(join(directory(), backups[0]), "utf8"), raw);
  assert.ok(prompt.includes(JSON.stringify(join(directory(), backups[0]))));
});

test("loading reads the latest file without triggering a turn, then handoff targets a separate file", async () => {
  const { id, path } = await writeDocument(
    "upstream",
    project,
    `${BODY}\n\n手动补充`,
  );
  const original = await readFile(path, "utf8");
  const h = harness("downstream");
  await h.run("handoff-open", id);
  assert.equal(h.prompts.length, 0);
  assert.equal(h.messages.length, 1);
  const [message, options] = h.messages[0];
  assert.equal(message.display, true);
  assert.equal(options?.triggerTurn, false);
  assert.match(String(message.content), /手动补充/);
  assert.match(String(message.content), /不代表新的执行授权/);
  await h.run("handoff");
  const ownId = handoffId(project, "downstream");
  assert.notEqual(id, ownId);
  assert.match(String(h.prompts[0][0]), new RegExp(ownId));
  assert.equal(await readFile(path, "utf8"), original);
});

test("selector filters projects, sorts manual changes and supports cancellation", async () => {
  const pickerProject = join(root, "picker-project");
  await mkdir(pickerProject);
  const canonical = await projectPath(pickerProject);
  const first = await writeDocument("first", canonical);
  await writeDocument("second", canonical);
  await utimes(first.path, new Date("2030-01-01"), new Date("2030-01-01"));
  await writeFile(
    handoffPath(directory(), "0000000000000000"),
    "broken metadata",
  );
  const h = harness();
  h.ctx.cwd = pickerProject;
  await h.run("handoff-open");
  assert.equal(h.messages.length, 0);
  assert.equal(h.choices().length, 2);
  assert.ok(h.choices()[0].startsWith(first.id));
  h.setSelection("first");
  await h.run("handoff-open");
  assert.match(String(h.messages[0][0].content), new RegExp(first.id));
});

test("invalid IDs, missing and empty documents report errors without loading", async () => {
  const h = harness();
  await h.run("handoff-open", "../../outside");
  assert.match(h.notices.at(-1) ?? "", /Invalid handoff ID/);
  await h.run("handoff-open", "1111111111111111");
  assert.match(h.notices.at(-1) ?? "", /not found/);
  const { id } = await writeDocument("empty", project, "");
  await h.run("handoff-open", id);
  assert.match(h.notices.at(-1) ?? "", /empty/);
  assert.equal(h.messages.length, 0);
});

test("empty sessions do not enqueue a generation task", async () => {
  const h = harness();
  h.ctx.sessionManager.getLeafId = () => null;
  await h.run("handoff");
  assert.match(h.notices.at(-1) ?? "", /empty session/);
  assert.equal(h.prompts.length, 0);
});

test("instructions cover flexible sections, privacy, preservation, tools and verification", () => {
  assert.match(HANDOFF_INSTRUCTIONS, /允许保留有用的额外章节/);
  assert.match(HANDOFF_INSTRUCTIONS, /只引用路径或 URL/);
  assert.match(HANDOFF_INSTRUCTIONS, /隐去密钥/);
  assert.match(HANDOFF_INSTRUCTIONS, /只推荐当前已知存在/);
  assert.match(HANDOFF_INSTRUCTIONS, /所需工具不可用/);
  assert.match(HANDOFF_INSTRUCTIONS, /读取文件确认已保存/);
});

test("renderer uses native expansion and Markdown without metadata JSON", () => {
  const h = harness();
  const theme = {
    fg: (_color: string, value: string) => value,
    bg: (_color: string, value: string) => value,
  } as Theme;
  const renderer = h.renderers.get("pi-handoff");
  assert.ok(renderer);
  const message = {
    role: "custom" as const,
    timestamp: 0,
    customType: "pi-handoff",
    content: BODY,
    display: true,
    details: { id: "a7f3", title: "测试", goal: "修复剩余测试" },
  };
  const options = {
    expanded: false,
    outputPad: 1,
    keyText: () => "Ctrl+O",
    keyHint: () => "Ctrl+O 展开查看全文",
  };
  const collapsed = renderer(message, options, theme);
  const expanded = renderer(message, { ...options, expanded: true }, theme);
  assert.ok(collapsed && expanded);
  const lines = (component: typeof collapsed) =>
    component.render(80).map(stripTerminalSequences).join("\n");
  assert.match(lines(collapsed), /等待你的下一步指示/);
  assert.doesNotMatch(lines(collapsed), /Suggested skills/);
  assert.match(lines(expanded), /Suggested skills/);
  assert.doesNotMatch(lines(expanded), /"goal"/);
});
