import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionToolContext,
  ToolDefinition,
  ToolLoadout,
} from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import { useAgentDir } from "../../tests/helpers/agent-dir.ts";
import type { Executor } from "./execute/index.ts";
import { resolveExecutor } from "./execute/resolve.ts";
import subagentExtension, { registerSubagents } from "./index.ts";
import {
  type AgentSnapshot,
  createSubagentManager,
  type ManagerOptions,
  type SendOptions,
  type SpawnOptions,
  type SubagentManager,
} from "./manager.ts";

function withManagerOverrides(
  overrides:
    | Partial<SubagentManager>
    | ((
        base: SubagentManager,
        options?: ManagerOptions,
      ) => Partial<SubagentManager>),
): typeof createSubagentManager {
  return (executor, options) => {
    const base = createSubagentManager(executor, options);
    const extra =
      typeof overrides === "function" ? overrides(base, options) : overrides;
    return { ...base, ...extra };
  };
}

function environment(t: TestContext, env: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(env)) {
    const previous = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
    t.after(() => {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    });
  }
}

function registrations() {
  const tools: string[] = [];
  const commands: string[] = [];
  const hooks: string[] = [];
  type Hook = (event?: unknown, ctx?: ExtensionContext) => void | Promise<void>;
  const hookHandlers = new Map<string, Hook>();
  const definitions = new Map<string, ToolDefinition>();
  const commandHandlers = new Map<
    string,
    Parameters<ExtensionAPI["registerCommand"]>[1]
  >();
  const pi = {
    registerMessageRenderer() {},
    registerTool(tool: ToolDefinition) {
      tools.push(tool.name);
      definitions.set(tool.name, tool);
    },
    registerCommand(
      name: string,
      definition: Parameters<ExtensionAPI["registerCommand"]>[1],
    ) {
      commands.push(name);
      commandHandlers.set(name, definition);
    },
    on(event: string, handler: Hook) {
      hooks.push(event);
      const previous = hookHandlers.get(event);
      hookHandlers.set(
        event,
        previous
          ? async (...args) => {
              await previous(...args);
              await handler(...args);
            }
          : handler,
      );
    },
  } as unknown as ExtensionAPI;
  return {
    pi,
    tools,
    commands,
    hooks,
    hookHandlers,
    definitions,
    commandHandlers,
  };
}

test("subagent registers two tools everywhere by default (falling back to subprocess) and respects worker guard", (t) => {
  useAgentDir(t);
  environment(t, {
    HC_TERMINAL_ID: undefined,
    PI_KITS_SUBAGENT_WORKER: undefined,
  });
  const active = registrations();
  subagentExtension(active.pi);
  assert.deepEqual(active.tools, ["subagent", "subagent_ctl"]);
  assert.deepEqual(active.commands, ["subagent:views"]);
  assert.equal(resolveExecutor(process.env).id, "subprocess");

  // Worker recursion guard
  environment(t, { PI_KITS_SUBAGENT_WORKER: "1" });
  const worker = registrations();
  subagentExtension(worker.pi);
  assert.deepEqual(worker.tools, []);
});

test("both tools share the pi-subagent namespace and dynamically surface configured agents", async (t) => {
  const cwd = useAgentDir(t);
  const agentsDir = join(cwd, ".pi", "agent", "agents");
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(
    join(agentsDir, "explorer.md"),
    "---\ndescription: Fast codebase search\n---\nExplore",
  );

  const capture = registrations();
  registerSubagents(capture.pi, {} as Executor);
  assert.equal(capture.definitions.size, 2);
  const subagent = capture.definitions.get("subagent");
  const ctl = capture.definitions.get("subagent_ctl");
  assert.ok(subagent && ctl);
  assert.equal(subagent.namespace?.name, "pi-subagent");
  assert.equal(ctl.namespace?.name, "pi-subagent");

  await capture.hookHandlers.get("session_start")?.({}, {
    cwd,
    mode: "print",
  } as ExtensionContext);
  const loadoutChanges = subagent.prepareLoadout?.({} as ToolLoadout);
  assert.match(
    loadoutChanges?.descriptions?.subagent ?? "",
    /Configured agents: explorer \(Fast codebase search\)/,
  );
  const agentProp = (
    subagent.parameters as {
      properties?: { agent?: { description?: string } };
    }
  ).properties?.agent;
  assert.equal(
    agentProp?.description,
    "Agent profile name; omit for a default session. Configured agents: explorer (Fast codebase search).",
  );
});

test("subagent tool routes omit-id to spawn and with-id to send; subagent_ctl routes wait/status/stop", async (t) => {
  const cwd = useAgentDir(t);
  const capture = registrations();
  const spawned: SpawnOptions[] = [];
  const sent: Array<{ id: string; options: SendOptions }> = [];
  const stopped: string[] = [];
  const waited: Array<{ id: string; wait?: boolean }> = [];

  capture.pi.getThinkingLevel = () => "medium";
  registerSubagents(
    capture.pi,
    {} as Executor,
    undefined,
    undefined,
    withManagerOverrides({
      spawn(options: SpawnOptions) {
        spawned.push(options);
        return {
          id: "sub-1",
          description: options.description ?? "Task",
          cwd: options.cwd,
          status: "running",
          hint: "Running hint",
        };
      },
      async send(id: string, options: SendOptions) {
        sent.push({ id, options });
        return {
          id,
          description: options.description ?? "Task",
          status: "queued",
          round: 2,
          hint: "Resumed hint",
        };
      },
      async result(id: string, wait?: boolean) {
        waited.push({ id, wait });
        return {
          id,
          description: "Task",
          status: "completed",
          result: "Done",
          hint: "Completed hint",
        };
      },
      stop(id: string) {
        stopped.push(id);
        return {
          id,
          description: "Task",
          status: "stopped",
          hint: "Stopped hint",
        };
      },
      backgroundPreference: () => undefined,
    }),
  );

  const subagent = capture.definitions.get("subagent");
  const ctl = capture.definitions.get("subagent_ctl");
  assert.ok(subagent && ctl);
  const ctx = { cwd, mode: "print", hasUI: false } as ExtensionToolContext;

  // 1. Spawn (no id)
  assert.equal(Value.Check(subagent.parameters, { prompt: "Find bugs" }), true);
  const spawnRes = await subagent.execute(
    "c1",
    { prompt: "Find bugs" },
    undefined,
    undefined,
    ctx,
  );
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].prompt, "Find bugs");
  assert.equal(spawned[0].cwd, cwd);
  assert.equal((spawnRes.details as AgentSnapshot).id, "sub-1");

  // 2. Send (with id)
  const sendRes = await subagent.execute(
    "c2",
    { id: "sub-1", prompt: "Fix them" },
    undefined,
    undefined,
    ctx,
  );
  assert.equal(sent.length, 1);
  assert.equal(sent[0].id, "sub-1");
  assert.equal(sent[0].options.prompt, "Fix them");
  assert.equal((sendRes.details as AgentSnapshot).round, 2);

  // 3. Control: status, wait, stop
  await ctl.execute(
    "c3",
    { id: "sub-1", action: "status" },
    undefined,
    undefined,
    ctx,
  );
  await ctl.execute(
    "c4",
    { id: "sub-1", action: "wait" },
    undefined,
    undefined,
    ctx,
  );
  await ctl.execute(
    "c5",
    { id: "sub-1", action: "stop" },
    undefined,
    undefined,
    ctx,
  );
  assert.deepEqual(waited, [
    { id: "sub-1", wait: false },
    { id: "sub-1", wait: true },
  ]);
  assert.deepEqual(stopped, ["sub-1"]);
});

test("invalid cwd rejects before manager spawn", async (t) => {
  const cwd = useAgentDir(t);
  const capture = registrations();
  registerSubagents(capture.pi, {} as Executor);
  const subagent = capture.definitions.get("subagent");
  assert.ok(subagent);
  await assert.rejects(
    subagent.execute(
      "call",
      { prompt: "Inspect", cwd: "missing-directory" },
      undefined,
      undefined,
      { cwd, mode: "print" } as ExtensionToolContext,
    ),
    /Invalid subagent cwd/,
  );
});

test("foreground subagent and subagent_ctl wait stream deduplicated progress via onUpdate and return structuredContent", async (t) => {
  const cwd = useAgentDir(t);
  const capture = registrations();
  capture.pi.getThinkingLevel = () => "medium";

  const listeners = new Set<() => void>();
  let currentSnapshot: AgentSnapshot = {
    id: "sub-1",
    description: "Inspect repo",
    subagentType: "explorer",
    status: "queued",
    round: 1,
    result: "stale-result-should-be-omitted-in-progress",
  };
  let resolveWait!: (snap: AgentSnapshot) => void;

  registerSubagents(
    capture.pi,
    {} as Executor,
    undefined,
    undefined,
    withManagerOverrides({
      list: () => [currentSnapshot],
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      spawn() {
        return currentSnapshot;
      },
      result(_id, wait) {
        if (!wait) return Promise.resolve(currentSnapshot);
        return new Promise((resolve) => {
          resolveWait = resolve;
        });
      },
      backgroundPreference: () => undefined,
    }),
  );

  const subagent = capture.definitions.get("subagent");
  const ctl = capture.definitions.get("subagent_ctl");
  assert.ok(subagent && ctl);
  assert.ok(subagent.outputSchema);
  assert.ok(ctl.outputSchema);

  const updates: Array<{
    content: Array<{ type: string; text?: string }>;
    details?: unknown;
  }> = [];
  const ctx = {
    cwd,
    mode: "rpc",
    hasUI: true,
  } as ExtensionToolContext;

  const pending = ctl.execute(
    "c-wait",
    { id: "sub-1", action: "wait" },
    undefined,
    (partial) => {
      updates.push(
        partial as {
          content: Array<{ type: string; text?: string }>;
          details?: unknown;
        },
      );
    },
    ctx,
  );

  // Initial frame emitted immediately without carrying stale result
  assert.equal(updates.length, 1);
  assert.match(
    updates[0].content[0]?.text ?? "",
    /\[sub-1\] explorer · Inspect repo · queued/,
  );
  assert.equal((updates[0].details as AgentSnapshot).result, undefined);

  // Duplicate notification with identical state should not emit again
  for (const listener of listeners) listener();
  assert.equal(updates.length, 1);

  // State transition after throttle window emits updated activity
  currentSnapshot = {
    ...currentSnapshot,
    status: "running",
    sessionActivity: "Reading index.ts",
  };
  for (const listener of listeners) listener();
  await new Promise((r) => setTimeout(r, 350));
  assert.equal(updates.length, 2);
  assert.match(
    updates[1].content[0]?.text ?? "",
    /running · round 1 · Reading index\.ts/,
  );

  // Final resolution returns readable text content + structuredContent + details
  const finalSnap: AgentSnapshot = {
    ...currentSnapshot,
    status: "completed",
    sessionActivity: undefined,
    result: "All checks passed.",
    sessionPath: "/tmp/sub-1.jsonl",
    hint: "Done.",
  };
  resolveWait(finalSnap);
  const res = await pending;

  assert.equal(listeners.size, 1); // only status widget remains subscribed
  const text = (res.content[0] as { text: string }).text;
  assert.match(text, /\[sub-1\] explorer · Inspect repo · completed/);
  assert.match(text, /All checks passed\./);
  assert.match(text, /Session: \/tmp\/sub-1\.jsonl/);
  assert.match(text, /Next: Done\./);
  assert.equal(Value.Check(ctl.outputSchema, res.structuredContent), true);
  assert.equal(
    (res.structuredContent as { result?: string }).result,
    "All checks passed.",
  );
  assert.equal((res.details as AgentSnapshot).id, "sub-1");
});
