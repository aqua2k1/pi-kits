import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import type { TestContext } from "node:test";
import { test } from "node:test";
import { createSubagentManager } from "../manager.ts";
import type { AgentRuntime, RuntimeSession } from "../runtime/index.ts";
import {
  createHerdrAdapter,
  HerdrError,
  type HerdrRunner,
  type RunOptions,
  type RunResult,
} from "./herdr.ts";
import {
  type MuxAdapter,
  type StartOptions,
  type TerminalHandle,
  TerminalStartError,
} from "./index.ts";

const binary = "/installed/herdr with ' quotes";
const startOptions: StartOptions = {
  agentId: "550e8400-e29b-41d4-a716-446655440000",
  agentType: "reviewer",
  cwd: "/tmp/work dir",
  argv: ["pi", "-e", "/tmp/worker.ts"],
  env: { WORKER_TOKEN: "worker-token" },
};

function environment(t: TestContext): void {
  const saved = {
    HERDR_ENV: process.env.HERDR_ENV,
    HERDR_PANE_ID: process.env.HERDR_PANE_ID,
    HERDR_BIN_PATH: process.env.HERDR_BIN_PATH,
  };
  process.env.HERDR_ENV = "1";
  process.env.HERDR_PANE_ID = "parent:p1";
  process.env.HERDR_BIN_PATH = binary;
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

function ok(result: unknown): RunResult {
  return { exitCode: 0, stdout: JSON.stringify({ result }), stderr: "" };
}

function failure(
  code = "not_found",
  message = `mock ${code}`,
  exitCode = 1,
): RunResult {
  return {
    exitCode,
    stdout: "",
    stderr: JSON.stringify({ error: { code, message } }),
  };
}

function info(id: string, workspaceId: string) {
  return {
    pane_id: id,
    terminal_id: `terminal-${id}`,
    workspace_id: workspaceId,
  };
}

class FakeHerdr {
  calls: { binary: string; argv: string[]; options: RunOptions }[] = [];
  panes = new Map([
    ["parent:p1", info("parent:p1", "parent")],
    ["external:p1", info("external:p1", "external")],
  ]);
  intercept?: (argv: string[]) => RunResult | undefined;
  neighbor = "parent:p2";
  private nextWorker = 1;
  private nextView = 2;

  runner: HerdrRunner = async (file, argv, options) => {
    this.calls.push({ binary: file, argv: [...argv], options });
    const intercepted = this.intercept?.(argv);
    if (intercepted) return intercepted;
    const [group, action, target] = argv;
    if (group === "workspace" && action === "create") {
      const workspace = `worker${this.nextWorker++}`;
      const root = info(`${workspace}:p1`, workspace);
      this.panes.set(root.pane_id, root);
      return ok({ workspace: { workspace_id: workspace }, root_pane: root });
    }
    if (group === "workspace" && action === "close") {
      for (const [id, pane] of this.panes) {
        if (pane.workspace_id === target) this.panes.delete(id);
      }
      return ok({ type: "ok" });
    }
    assert.equal(group, "pane");
    if (action === "get") {
      const pane = this.panes.get(target);
      return pane ? ok({ pane }) : failure();
    }
    if (action === "list") {
      return ok({
        panes: [...this.panes.values()].filter(
          (pane) => target === undefined || pane.workspace_id === argv[3],
        ),
      });
    }
    if (action === "split") {
      assert.equal(target, "--pane");
      assert.ok(this.panes.has(argv[3]));
      const pane = info(`parent:p${this.nextView++}`, "parent");
      this.panes.set(pane.pane_id, pane);
      return ok({ pane });
    }
    if (action === "run") return { exitCode: 0, stdout: "", stderr: "" };
    if (action === "neighbor") {
      return ok({ neighbor: { neighbor_pane_id: this.neighbor } });
    }
    if (action === "focus") return ok({ type: "ok" });
    if (action === "close") {
      this.panes.delete(target);
      return ok({ type: "ok" });
    }
    throw new Error(`Unexpected command: ${argv}`);
  };

  adapter(): MuxAdapter {
    return createHerdrAdapter({ runner: this.runner });
  }

  commands(group: string, action: string): string[][] {
    return this.calls
      .map((call) => call.argv)
      .filter((argv) => argv[0] === group && argv[1] === action);
  }
}

function code(expected: string) {
  return (error: unknown) => {
    assert.ok(error instanceof HerdrError);
    assert.equal(error.code, expected);
    return true;
  };
}

function shellWords(command: string): string[] {
  const script = `set -- ${command}\nprintf '%s\\0' "$@"`;
  return execFileSync("/bin/sh", ["-c", script], { encoding: "utf8" })
    .split("\0")
    .slice(0, -1);
}

test("construction has no CLI side effects and check_env only reads HERDR_ENV", (t) => {
  environment(t);
  const adapter = createHerdrAdapter({
    runner: () => assert.fail("must not invoke CLI"),
  });
  assert.equal(adapter.check_env(), true);
  process.env.HERDR_ENV = "0";
  assert.equal(adapter.check_env(), false);
});

test("start creates a no-focus workspace with env and quotes argv safely", async (t) => {
  environment(t);
  const fake = new FakeHerdr();
  const adapter = fake.adapter();
  const argv = ["pi", "-e", "a 'b' \"c\" $HOME $(id)", ""];
  const terminal = await adapter.start({ ...startOptions, argv });
  assert.deepEqual(Object.keys(terminal), ["id"]);
  assert.deepEqual(fake.commands("workspace", "create")[0], [
    "workspace",
    "create",
    "--cwd",
    startOptions.cwd,
    "--label",
    `sub-reviewer-${startOptions.agentId}`,
    "--no-focus",
    "--env",
    "WORKER_TOKEN=worker-token",
  ]);
  assert.deepEqual(shellWords(fake.commands("pane", "run")[0][3]), [
    "exec",
    ...argv,
  ]);

  await adapter.start({ ...startOptions, agentType: undefined });
  assert.ok(
    fake
      .commands("workspace", "create")[1]
      .includes(`sub-anonymous-${startOptions.agentId}`),
  );
});

test("open/focus/close view manages right-then-down column layout without affecting worker", async (t) => {
  environment(t);
  const fake = new FakeHerdr();
  const adapter = fake.adapter();
  const terminal = await adapter.start(startOptions);
  const first = await adapter.open_view({ terminal });
  const second = await adapter.open_view({ terminal });
  const third = await adapter.open_view({ terminal });
  assert.deepEqual(
    fake.commands("pane", "split").map((argv) => [argv[3], argv[5]]),
    [
      ["parent:p1", "right"],
      ["parent:p2", "down"],
      ["parent:p3", "down"],
    ],
  );
  assert.deepEqual(shellWords(fake.commands("pane", "run")[1][3]), [
    binary,
    "terminal",
    "attach",
    "terminal-worker1:p1",
  ]);

  // Surviving sibling routing when middle pane closes.
  await adapter.close_view(second);
  const neighbors = new Map([
    ["parent:p1/right", "parent:p2"],
    ["parent:p2/down", "parent:p4"],
  ]);
  fake.intercept = (argv) =>
    argv[1] === "neighbor"
      ? ok({
          neighbor: {
            neighbor_pane_id: neighbors.get(`${argv[3]}/${argv[5]}`),
          },
        })
      : undefined;
  await adapter.focus_view(third);
  assert.deepEqual(fake.commands("pane", "focus").at(-1), [
    "pane",
    "focus",
    "--pane",
    "parent:p2",
    "--direction",
    "down",
  ]);
  fake.intercept = undefined;

  // Dead latest view falls back to previous surviving view; closing all resets to right.
  fake.panes.delete("parent:p4");
  assert.deepEqual(await adapter.inspect_view(third), { alive: false });
  const fourth = await adapter.open_view({ terminal });
  assert.deepEqual(fake.commands("pane", "split").at(-1)?.slice(2, 6), [
    "--pane",
    "parent:p2",
    "--direction",
    "down",
  ]);
  for (const view of [first, third, fourth]) {
    await adapter.close_view(view);
  }
  await adapter.open_view({ terminal });
  assert.deepEqual(fake.commands("pane", "split").at(-1)?.slice(2, 6), [
    "--pane",
    "parent:p1",
    "--direction",
    "right",
  ]);
  assert.deepEqual(await adapter.inspect(terminal), { alive: true });
});

test("destroy closes views and workspace, refuses unowned panes, and handles Herdr 0.9 missing codes", async (t) => {
  environment(t);
  const fake = new FakeHerdr();
  const adapter = fake.adapter();
  const terminal = await adapter.start(startOptions);
  await adapter.open_view({ terminal });
  fake.panes.set("worker1:p9", info("worker1:p9", "worker1"));
  await assert.rejects(
    adapter.destroy(terminal),
    code("workspace_contains_unowned_panes"),
  );
  assert.equal(fake.commands("workspace", "close").length, 0);
  fake.panes.delete("worker1:p9");
  await adapter.destroy(terminal);
  assert.deepEqual([...fake.panes.keys()], ["parent:p1", "external:p1"]);
  await assert.rejects(adapter.destroy(terminal), code("unowned_terminal"));

  // Missing pane/workspace codes allow idempotent cleanup.
  fake.intercept = (argv) => {
    if (argv[0] === "pane" && argv[1] === "get" && !fake.panes.has(argv[2])) {
      return failure("pane_not_found");
    }
    if (
      argv[0] === "pane" &&
      argv[1] === "list" &&
      ![...fake.panes.values()].some((p) => p.workspace_id === argv[3])
    ) {
      return failure("workspace_not_found");
    }
  };
  const second = await adapter.start(startOptions);
  const view = await adapter.open_view({ terminal: second });
  fake.panes.delete("parent:p3");
  await adapter.close_view(view);
  fake.panes.delete("worker2:p1");
  assert.deepEqual(await adapter.inspect(second), { alive: false });
  await adapter.destroy(second);
});

test("start and attachment failures roll back owned resources and surface error details", async (t) => {
  environment(t);
  const fake = new FakeHerdr();
  fake.intercept = (argv) =>
    argv[1] === "run" ? failure("agent_not_ready", "pane busy", 0) : undefined;
  await assert.rejects(fake.adapter().start(startOptions), (error: unknown) => {
    assert.ok(error instanceof HerdrError);
    assert.equal(error.code, "agent_not_ready");
    assert.match(error.message, /pane busy/);
    return true;
  });
  assert.deepEqual(fake.commands("workspace", "close"), [
    ["workspace", "close", "worker1"],
  ]);

  // If rollback itself fails, TerminalStartError retains the handle for retry.
  const fake2 = new FakeHerdr();
  let allowClose = false;
  fake2.intercept = (argv) => {
    if (argv[1] === "run") return failure("agent_not_ready");
    if (argv[0] === "workspace" && argv[1] === "close" && !allowClose) {
      return failure("unavailable");
    }
  };
  const adapter2 = fake2.adapter();
  let handle: TerminalHandle | undefined;
  await assert.rejects(adapter2.start(startOptions), (error: unknown) => {
    assert.ok(error instanceof TerminalStartError);
    handle = error.terminal;
    return true;
  });
  assert.ok(handle);
  allowClose = true;
  await adapter2.destroy(handle);

  // Attachment run failure rolls back only the attachment pane.
  const fake3 = new FakeHerdr();
  const adapter3 = fake3.adapter();
  const terminal = await adapter3.start(startOptions);
  fake3.intercept = (argv) =>
    argv[1] === "run" ? failure("terminal_busy") : undefined;
  await assert.rejects(adapter3.open_view({ terminal }), code("terminal_busy"));
  assert.deepEqual(fake3.commands("pane", "close"), [
    ["pane", "close", "parent:p2"],
  ]);
  assert.deepEqual(await adapter3.inspect(terminal), { alive: true });
});

test("manager and Herdr compose runtime destruction with stale-view cleanup and serialize races", async (t) => {
  environment(t);
  const fake = new FakeHerdr();
  let notifySplit = () => {};
  let releaseSplit = () => {};
  const started = new Promise<void>((resolve) => {
    notifySplit = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    releaseSplit = resolve;
  });
  const adapter = createHerdrAdapter({
    runner: async (file, argv, options) => {
      const result = await fake.runner(file, argv, options);
      if (argv[1] === "split") {
        notifySplit();
        await gate;
      }
      return result;
    },
  });
  const terminal = await adapter.start(startOptions);
  const opening = adapter.open_view({ terminal });
  await started;
  const shutdown = adapter.destroy(terminal);
  assert.equal(fake.commands("workspace", "close").length, 0);
  releaseSplit();
  await Promise.all([opening, shutdown]);
  assert.deepEqual([...fake.panes.keys()], ["parent:p1", "external:p1"]);

  // Manager close after runtime already destroyed terminal retires stale views cleanly.
  const fake2 = new FakeHerdr();
  const adapter2 = fake2.adapter();
  let sessionTerminal: TerminalHandle | undefined;
  const runtime: AgentRuntime = {
    id: "custom",
    capabilities: {
      nativeClone: false,
      steer: false,
      retainedSession: true,
      concurrentNativeInput: true,
    },
    validate() {},
    create(options, host): RuntimeSession {
      return {
        capabilities: runtime.capabilities,
        connected: true,
        get terminal() {
          return sessionTerminal;
        },
        async start() {
          sessionTerminal = await host.mux.start({
            agentId: options.id,
            cwd: options.cwd,
            argv: ["pi"],
            env: {},
          });
          host.emit({ type: "session_state", state: "idle" });
        },
        send() {},
        async inspect() {
          return true;
        },
        async attachment() {
          assert.ok(sessionTerminal);
          return sessionTerminal;
        },
        async close() {
          if (sessionTerminal) await host.mux.destroy(sessionTerminal);
        },
      };
    },
  };
  const manager = createSubagentManager(adapter2, { runtimes: [runtime] });
  const agent = manager.spawn({
    runtime: "custom",
    prompt: "work",
    description: "work",
    cwd: "/tmp",
    keepAlive: true,
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  await manager.openView(agent.id);
  await manager.close();
  assert.deepEqual([...fake2.panes.keys()], ["parent:p1", "external:p1"]);
});

test("foreign handles, missing env/parent, and invalid start options reject cleanly", async (t) => {
  environment(t);
  const fake = new FakeHerdr();
  const adapter = fake.adapter();
  await assert.rejects(
    adapter.inspect({ id: "foreign" }),
    code("unowned_terminal"),
  );
  await assert.rejects(
    adapter.close_view({ id: "foreign" }),
    code("unowned_view"),
  );
  assert.equal(fake.calls.length, 0);

  process.env.HERDR_ENV = "0";
  await assert.rejects(adapter.start(startOptions), code("not_in_herdr"));
  process.env.HERDR_ENV = "1";
  await assert.rejects(
    adapter.start({ ...startOptions, cwd: "relative" }),
    code("invalid_start"),
  );
  const terminal = await adapter.start(startOptions);
  delete process.env.HERDR_PANE_ID;
  await assert.rejects(
    adapter.open_view({ terminal }),
    code("missing_parent_pane"),
  );
});
