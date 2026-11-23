import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { useAgentDir } from "../../tests/helpers/agent-dir.ts";
import { parseAgentDefinition } from "./config.ts";
import type {
  Executor,
  OpenViewOptions,
  StartOptions,
  TerminalHandle,
  ViewHandle,
} from "./execute/index.ts";
import { createSubagentManager } from "./manager.ts";

function createFakeExecutor(supportsView = true) {
  const started: StartOptions[] = [];
  const commands = new Map<string, Record<string, unknown>[]>();
  const sockets = new Map<string, Socket>();
  const destroyed: string[] = [];
  const closedViews: string[] = [];
  const focused: string[] = [];
  const opened: OpenViewOptions[] = [];
  const missingViews = new Set<string>();

  const emit = (id: string, event: Record<string, unknown>) => {
    const command = commands.get(id)?.findLast((item) => item.type === "task");
    const frame =
      event.type === "ready" || event.type === "session_state"
        ? event
        : { round: command?.round, ...event };
    sockets.get(id)?.write(`${JSON.stringify(frame)}\n`);
  };

  const executor: Executor = {
    id: "herdr-core",
    supportsView,
    check_env: () => true,
    async start(options: StartOptions): Promise<TerminalHandle> {
      started.push(options);
      const [host, port] = options.env.PI_KITS_SUBAGENT_ENDPOINT.split(":");
      const socket = connect({ host, port: Number(port) });
      sockets.set(options.agentId, socket);
      const existing = commands.get(options.agentId) ?? [];
      commands.set(options.agentId, existing);
      socket.setEncoding("utf8");
      socket.on("error", () => undefined);
      socket.on("connect", () => {
        emit(options.agentId, {
          type: "ready",
          id: options.agentId,
          token: options.env.PI_KITS_SUBAGENT_TOKEN,
          sessionPath: `/tmp/session-${options.agentId}.jsonl`,
        });
      });
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk;
        let newline = buffer.indexOf("\n");
        while (newline >= 0) {
          commands
            .get(options.agentId)
            ?.push(JSON.parse(buffer.slice(0, newline)));
          buffer = buffer.slice(newline + 1);
          newline = buffer.indexOf("\n");
        }
      });
      return { id: `${options.agentId}-term-${started.length}` };
    },
    inspect: async () => ({ alive: true }),
    async destroy(handle: TerminalHandle) {
      destroyed.push(handle.id);
      const agentId = handle.id.split("-term-")[0];
      sockets.get(agentId)?.destroy();
    },
    async open_view(options: OpenViewOptions): Promise<ViewHandle> {
      opened.push(options);
      return { id: `view-${options.terminal.id}-${opened.length}` };
    },
    async inspect_view(view: ViewHandle) {
      return {
        alive: !missingViews.has(view.id) && !closedViews.includes(view.id),
      };
    },
    async focus_view(view: ViewHandle) {
      focused.push(view.id);
    },
    async close_view(view: ViewHandle) {
      closedViews.push(view.id);
    },
  };

  return {
    executor,
    started,
    commands,
    destroyed,
    emit,
  };
}

async function until(check: () => boolean) {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await delay(5);
  }
  assert.fail("Condition did not become true");
}

const task = {
  prompt: "Inspect authentication",
  description: "Inspect auth",
  cwd: "/tmp/project",
};

test("spawn assigns short IDs, dynamic hints, and executes task commands", async (t) => {
  const exec = createFakeExecutor();
  const notifications: string[] = [];
  const manager = createSubagentManager(exec.executor, {
    extensionAllowlist: [],
    onComplete: (record) => notifications.push(record.id),
  });
  t.after(() => manager.close());

  const first = manager.spawn({ ...task, model: "sonnet", thinking: "high" });
  assert.equal(first.id, "sub-1");
  assert.match(first.hint ?? "", /subagent_ctl.*sub-1/);
  await until(() => exec.commands.get(first.id)?.length === 1);

  const start = exec.started[0];
  assert.equal(start.env.PI_KITS_SUBAGENT_WORKER, "1");
  assert.ok(start.argv.includes("--no-extensions"));
  assert.ok(start.argv.includes("sonnet"));
  assert.equal(
    manager.get(first.id).sessionPath,
    `/tmp/session-${first.id}.jsonl`,
  );

  // Unified send while running routes to steer
  const steered = await manager.send(first.id, {
    prompt: "Only inspect files",
  });
  assert.match(steered.hint ?? "", /Steering message delivered/);
  await until(() => exec.commands.get(first.id)?.length === 2);
  assert.deepEqual(exec.commands.get(first.id)?.[1], {
    type: "steer",
    message: "Only inspect files",
  });

  const waited = manager.result(first.id, true);
  exec.emit(first.id, { type: "completed", result: "Found auth.ts" });
  const completed = await waited;
  assert.equal(completed.result, "Found auth.ts");
  assert.equal(completed.status, "completed");
  assert.match(
    completed.hint ?? "",
    /Task completed.*subagent\(\{ id: "sub-1"/,
  );
  assert.deepEqual(notifications, []);
});

test("cold resume automatically restarts from saved sessionPath after process release", async (t) => {
  const exec = createFakeExecutor(false);
  const manager = createSubagentManager(exec.executor, {
    extensionAllowlist: [],
  });
  t.after(() => manager.close());

  const agent = manager.spawn(task);
  await until(() => exec.commands.get(agent.id)?.length === 1);
  assert.ok(exec.started[0].argv.includes("--session-id"));

  exec.emit(agent.id, { type: "completed", result: "Round 1 done" });
  await until(() => manager.get(agent.id).status === "completed");
  await until(() => exec.destroyed.length === 1);
  assert.equal(manager.get(agent.id).sessionState, "closed");

  // Send on a released session cold-restarts with --session <sessionPath>!
  const resumed = await manager.send(agent.id, {
    prompt: "Continue round 2",
    description: "Round 2",
  });
  assert.equal(resumed.round, 2);
  assert.equal(resumed.description, "Round 2");
  await until(() => exec.started.length === 2);
  const secondArgv = exec.started[1].argv;
  const sessionFlagIdx = secondArgv.indexOf("--session");
  assert.ok(
    sessionFlagIdx >= 0,
    "Cold resume must pass --session <sessionPath>",
  );
  assert.equal(
    secondArgv[sessionFlagIdx + 1],
    `/tmp/session-${agent.id}.jsonl`,
  );

  await until(() => exec.commands.get(agent.id)?.length === 2);
  assert.deepEqual(exec.commands.get(agent.id)?.[1], {
    type: "task",
    prompt: "Continue round 2",
    round: 2,
  });
});

test("hot resume reuses live terminal session without restarting process", async (t) => {
  const exec = createFakeExecutor();
  const manager = createSubagentManager(exec.executor, {
    extensionAllowlist: [],
  });
  t.after(() => manager.close());

  const agent = manager.spawn(task);
  await until(() => exec.commands.get(agent.id)?.length === 1);
  exec.emit(agent.id, { type: "completed", result: "Round 1" });
  await until(() => manager.get(agent.id).status === "completed");
  assert.equal(exec.destroyed.length, 0);

  await manager.send(agent.id, { prompt: "Hot round 2" });
  await until(() => exec.commands.get(agent.id)?.length === 2);
  assert.equal(exec.started.length, 1);
  assert.deepEqual(exec.commands.get(agent.id)?.[1], {
    type: "task",
    prompt: "Hot round 2",
    round: 2,
  });
});

test("agent definition configures tools, prompt files, extensions, and context inheritance", async (t) => {
  useAgentDir(t);
  const parent = SessionManager.inMemory(task.cwd);
  parent.appendMessage({
    role: "user",
    content: "Parent context",
    timestamp: 1,
  });

  const exec = createFakeExecutor();
  const manager = createSubagentManager(exec.executor, {
    extensionAllowlist: [],
  });
  t.after(() => manager.close());

  const definition = parseAgentDefinition(
    `---
model: agent-model
thinking: high
tools: read, grep
disallowed_tools: write
inherit_context: true
display_name: Reviewer
---
System instructions`,
    "/project/.pi/agent/agents/review.md",
    "project",
  );

  const agent = manager.spawn({
    ...task,
    agent: definition,
    context: parent,
  });
  await until(() => exec.commands.get(agent.id)?.length === 1);
  const argv = exec.started[0].argv;
  assert.equal(argv[argv.indexOf("--model") + 1], "agent-model");
  assert.equal(argv[argv.indexOf("--thinking") + 1], "high");
  assert.equal(argv[argv.indexOf("--tools") + 1], "read,grep");
  assert.equal(argv[argv.indexOf("--exclude-tools") + 1], "write");
  assert.ok(argv.includes("--session"));
  const promptPath = argv[argv.indexOf("--system-prompt") + 1];
  assert.equal(readFileSync(promptPath, "utf8"), "System instructions");
  assert.equal(agent.inheritedContext, true);

  await manager.close();
  assert.equal(existsSync(promptPath), false);
});

test("ECS data-driven entities derive status and sessionState purely from component presence", async (t) => {
  const exec = createFakeExecutor();
  const manager = createSubagentManager(exec.executor, {
    maxConcurrent: 1,
    extensionAllowlist: [],
  });
  t.after(() => manager.close());

  const first = manager.spawn(task);
  const second = manager.spawn({ ...task, description: "Queued sibling" });
  assert.equal(manager.get(second.id).status, "queued");
  assert.equal(manager.get(second.id).sessionState, undefined);

  await until(() => exec.commands.get(first.id)?.length === 1);
  assert.equal(manager.get(first.id).status, "running");
  assert.equal(manager.get(first.id).sessionState, "running");

  // Native interactive activity on worker component derives sessionState="interactive"
  exec.emit(first.id, { type: "completed", result: "Done 1" });
  await until(() => manager.get(first.id).status === "completed");
  assert.equal(manager.get(first.id).sessionState, "idle");

  exec.emit(first.id, {
    type: "session_state",
    state: "interactive",
    activity: "bash",
  });
  await until(() => manager.get(first.id).sessionState === "interactive");
  assert.equal(manager.get(first.id).status, "completed");
  assert.equal(manager.get(first.id).sessionActivity, "bash");
  assert.match(
    manager.get(first.id).hint ?? "",
    /interacting in the native terminal/,
  );
});
