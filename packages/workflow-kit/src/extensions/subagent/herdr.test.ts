import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import type { TestContext } from "node:test";
import { test } from "node:test";
import {
  HerdrAdapter,
  HerdrError,
  type HerdrRunner,
  type RunOptions,
  type RunResult,
  runHerdr,
} from "./herdr.ts";
import {
  type MuxAdapter,
  type StartOptions,
  type TerminalHandle,
  TerminalStartError,
} from "./mux.ts";

const binary = "/installed/herdr with ' quotes";
const startOptions: StartOptions = {
  agentId: "reviewer",
  cwd: "/tmp/work dir",
  argv: ["pi", "-e", "/tmp/worker.ts"],
  env: { WORKER_TOKEN: "secret-token" },
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

function failure(code = "not_found", exitCode = 1): RunResult {
  return {
    exitCode,
    stdout: "",
    stderr: JSON.stringify({ error: { code, message: "secret-token" } }),
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
      if (target !== undefined) assert.equal(target, "--workspace");
      return ok({
        panes: [...this.panes.values()].filter(
          (pane) => target === undefined || pane.workspace_id === argv[3],
        ),
      });
    }
    if (action === "split") {
      assert.equal(target, "--pane");
      assert.equal(argv[3], "parent:p1");
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

  adapter(): HerdrAdapter {
    return new HerdrAdapter({ runner: this.runner });
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
    assert.ok(!String(error).includes("secret-token"));
    return true;
  };
}

/** Parse the generated shell text without executing the provided command. */
function shellWords(command: string): string[] {
  const script = `set -- ${command}\nprintf '%s\\0' "$@"`;
  return execFileSync("/bin/sh", ["-c", script], { encoding: "utf8" })
    .split("\0")
    .slice(0, -1);
}

test("constructor has no CLI side effects; check_env only reads HERDR_ENV", (t) => {
  environment(t);
  const fake = new FakeHerdr();
  const adapter: MuxAdapter = fake.adapter();
  delete process.env.HERDR_BIN_PATH;
  delete process.env.HERDR_PANE_ID;
  for (const value of [undefined, "", "0", "true", "01", "1"]) {
    if (value === undefined) delete process.env.HERDR_ENV;
    else process.env.HERDR_ENV = value;
    assert.equal(adapter.check_env(), value === "1");
  }
  assert.equal(fake.calls.length, 0);
});

test("start creates a no-focus workspace with env, runs complete argv", async (t) => {
  environment(t);
  const fake = new FakeHerdr();
  const adapter = fake.adapter();
  const terminal = await adapter.start(startOptions);
  assert.deepEqual(Object.keys(terminal), ["id"]);
  assert.notEqual(terminal.id, "worker1:p1");
  assert.deepEqual(fake.commands("workspace", "create"), [
    [
      "workspace",
      "create",
      "--cwd",
      startOptions.cwd,
      "--label",
      "pi-subagent-reviewer",
      "--no-focus",
      "--env",
      "WORKER_TOKEN=secret-token",
    ],
  ]);
  assert.deepEqual(shellWords(fake.commands("pane", "run")[0][3]), [
    "exec",
    ...startOptions.argv,
  ]);
  assert.equal(fake.calls[0].binary, binary);
  assert.deepEqual(fake.calls[0].options, {
    timeoutMs: 15_000,
    maxOutputBytes: 1024 * 1024,
  });
  assert.deepEqual(await adapter.inspect(terminal), { alive: true });
});

test("quoted worker argv and attachment binary resist shell injection", async (t) => {
  environment(t);
  const fake = new FakeHerdr();
  const adapter = fake.adapter();
  const malicious = [
    "$(printf INJECTED)",
    "'; printf INJECTED; #",
    "`printf INJECTED`",
    "a b\nc d",
    '"; & | < > * \\ $HOME',
    "",
  ];
  const argv = ["pi", "-e", ...malicious];
  const terminal = await adapter.start({ ...startOptions, argv });
  assert.deepEqual(shellWords(fake.commands("pane", "run")[0][3]), [
    "exec",
    ...argv,
  ]);
  await adapter.open_view({ terminal, direction: "right" });
  assert.deepEqual(shellWords(fake.commands("pane", "run")[1][3]), [
    binary,
    "terminal",
    "attach",
    "terminal-worker1:p1",
  ]);
});

test("open/focus/close view only affects the new attachment pane", async (t) => {
  environment(t);
  const fake = new FakeHerdr();
  const adapter = fake.adapter();
  const terminal = await adapter.start(startOptions);
  const view = await adapter.open_view({ terminal, direction: "down" });
  assert.deepEqual(Object.keys(view), ["id"]);
  assert.deepEqual(fake.commands("pane", "split"), [
    [
      "pane",
      "split",
      "--pane",
      "parent:p1",
      "--direction",
      "down",
      "--cwd",
      startOptions.cwd,
      "--no-focus",
    ],
  ]);
  await adapter.focus_view(view);
  assert.deepEqual(fake.commands("pane", "focus"), [
    ["pane", "focus", "--pane", "parent:p1", "--direction", "down"],
  ]);
  await adapter.close_view(view);
  assert.deepEqual(fake.commands("pane", "close"), [
    ["pane", "close", "parent:p2"],
  ]);
  assert.deepEqual(await adapter.inspect(terminal), { alive: true });
  assert.ok(fake.panes.has("parent:p1"));
  assert.ok(fake.panes.has("external:p1"));
  assert.equal(fake.commands("workspace", "close").length, 0);
  assert.equal(fake.commands("pane", "move").length, 0);
  await assert.rejects(adapter.close_view(view), code("unowned_view"));
});

test("destroy closes its views and workspace, never the parent or outsiders", async (t) => {
  environment(t);
  const fake = new FakeHerdr();
  const adapter = fake.adapter();
  const terminal = await adapter.start(startOptions);
  await adapter.open_view({ terminal, direction: "right" });
  await adapter.open_view({ terminal, direction: "down" });
  await adapter.destroy(terminal);
  assert.deepEqual(fake.commands("workspace", "close"), [
    ["workspace", "close", "worker1"],
  ]);
  assert.deepEqual([...fake.panes.keys()], ["parent:p1", "external:p1"]);
  await assert.rejects(adapter.destroy(terminal), code("unowned_terminal"));
});

test("start failure rolls back the workspace, including JSON errors on exit 0", async (t) => {
  environment(t);
  for (const exitCode of [0, 1]) {
    const fake = new FakeHerdr();
    fake.intercept = (argv) =>
      argv[1] === "run" ? failure("agent_not_ready", exitCode) : undefined;
    await assert.rejects(
      fake.adapter().start(startOptions),
      code("agent_not_ready"),
    );
    assert.deepEqual(fake.commands("workspace", "close"), [
      ["workspace", "close", "worker1"],
    ]);
  }
});

test("executed start with a failed response retains ownership through cleanup retries", async (t) => {
  environment(t);
  for (const startFailure of ["response_error", "timeout", "output_limit"]) {
    const fake = new FakeHerdr();
    let allowClose = false;
    let executed = false;
    fake.intercept = (argv) =>
      argv[0] === "workspace" && argv[1] === "close" && !allowClose
        ? failure("unavailable")
        : undefined;
    const adapter = new HerdrAdapter({
      runner: async (file, argv, options) => {
        const result = await fake.runner(file, argv, options);
        if (argv[0] === "pane" && argv[1] === "run") {
          executed = true;
          if (startFailure === "response_error") {
            return failure("agent_not_ready", 0);
          }
          throw new HerdrError(startFailure);
        }
        return result;
      },
    });
    let terminal: TerminalHandle | undefined;
    await assert.rejects(adapter.start(startOptions), (error: unknown) => {
      assert.ok(error instanceof TerminalStartError);
      assert.ok(error.cause instanceof AggregateError);
      const [startError, cleanupError] = error.cause.errors;
      code(
        startFailure === "response_error" ? "agent_not_ready" : startFailure,
      )(startError);
      code("unavailable")(cleanupError);
      terminal = error.terminal;
      return true;
    });
    assert.ok(executed);
    assert.ok(terminal);
    assert.deepEqual(await adapter.inspect(terminal), { alive: true });
    await assert.rejects(adapter.destroy(terminal), code("unavailable"));
    assert.deepEqual(await adapter.inspect(terminal), { alive: true });
    allowClose = true;
    await adapter.destroy(terminal);
    assert.equal(fake.commands("workspace", "close").length, 3);
    assert.deepEqual([...fake.panes.keys()], ["parent:p1", "external:p1"]);
    await assert.rejects(adapter.destroy(terminal), code("unowned_terminal"));
  }
});

test("attachment submission failure closes only the attachment", async (t) => {
  environment(t);
  const fake = new FakeHerdr();
  const adapter = fake.adapter();
  const terminal = await adapter.start(startOptions);
  fake.intercept = (argv) =>
    argv[1] === "run" ? failure("terminal_busy") : undefined;
  await assert.rejects(
    adapter.open_view({ terminal, direction: "right" }),
    code("terminal_busy"),
  );
  assert.deepEqual(fake.commands("pane", "close"), [
    ["pane", "close", "parent:p2"],
  ]);
  assert.deepEqual(await adapter.inspect(terminal), { alive: true });
  assert.equal(fake.commands("workspace", "close").length, 0);
});

test("foreign and cross-instance handles are rejected without CLI calls", async (t) => {
  environment(t);
  const fake = new FakeHerdr();
  const adapter = fake.adapter();
  const foreign = { id: "external:p1" };
  await assert.rejects(adapter.inspect(foreign), code("unowned_terminal"));
  await assert.rejects(adapter.destroy(foreign), code("unowned_terminal"));
  await assert.rejects(adapter.close_view(foreign), code("unowned_view"));
  await assert.rejects(adapter.focus_view(foreign), code("unowned_view"));
  assert.equal(fake.calls.length, 0);
  const terminal = await adapter.start(startOptions);
  const calls = fake.calls.length;
  await assert.rejects(
    fake.adapter().destroy(terminal),
    code("unowned_terminal"),
  );
  assert.equal(fake.calls.length, calls);
});

test("destroy refuses foreign panes inside its workspace and can be retried", async (t) => {
  environment(t);
  const fake = new FakeHerdr();
  const adapter = fake.adapter();
  const terminal = await adapter.start(startOptions);
  fake.panes.set("worker1:p9", info("worker1:p9", "worker1"));
  await assert.rejects(
    adapter.destroy(terminal),
    code("workspace_contains_unowned_panes"),
  );
  assert.equal(fake.commands("workspace", "close").length, 0);
  fake.panes.delete("worker1:p9");
  await adapter.destroy(terminal);
});

test("moved worker with an empty or missing old workspace stays owned until stopped", async (t) => {
  environment(t);
  for (const missingWorkspace of [false, true]) {
    for (const aliasFollowsMove of [false, true]) {
      const fake = new FakeHerdr();
      const adapter = fake.adapter();
      const terminal = await adapter.start(startOptions);
      const moved = {
        ...info("external:p9", "external"),
        terminal_id: "terminal-worker1:p1",
      };
      fake.panes.delete("worker1:p1");
      fake.panes.set(moved.pane_id, moved);
      let movedAlive = true;
      fake.intercept = (argv) => {
        if (missingWorkspace && argv[1] === "list" && argv[3] === "worker1") {
          return failure();
        }
        if (
          movedAlive &&
          aliasFollowsMove &&
          argv[1] === "get" &&
          argv[2] === "worker1:p1"
        ) {
          return ok({ pane: moved });
        }
      };
      await assert.rejects(
        adapter.destroy(terminal),
        code("terminal_not_stopped"),
      );
      await assert.rejects(
        adapter.destroy(terminal),
        code("terminal_not_stopped"),
      );
      assert.equal(fake.commands("workspace", "close").length, 0);
      assert.equal(fake.commands("pane", "close").length, 0);
      assert.ok(fake.panes.has(moved.pane_id));
      movedAlive = false;
      fake.panes.delete(moved.pane_id);
      await adapter.destroy(terminal);
      assert.ok(fake.panes.has("external:p1"));
      assert.ok(fake.panes.has("parent:p1"));
      assert.ok(
        fake
          .commands("workspace", "close")
          .every((argv) => argv[2] === "worker1"),
      );
      await assert.rejects(adapter.destroy(terminal), code("unowned_terminal"));
    }
  }
});

test("a replaced old pane alias cannot authorize cleanup of an empty workspace", async (t) => {
  environment(t);
  const fake = new FakeHerdr();
  const adapter = fake.adapter();
  const terminal = await adapter.start(startOptions);
  fake.panes.delete("worker1:p1");
  fake.intercept = (argv) =>
    argv[1] === "get" && argv[2] === "worker1:p1"
      ? ok({ pane: info("external:p1", "external") })
      : undefined;
  await assert.rejects(adapter.destroy(terminal), code("terminal_not_stopped"));
  assert.equal(fake.commands("workspace", "close").length, 0);
  fake.intercept = undefined;
  await adapter.destroy(terminal);
  assert.ok(fake.panes.has("external:p1"));
});

test("destroy fails closed when stopped identity cannot be confirmed", async (t) => {
  environment(t);
  for (const failedRead of ["get", "list"]) {
    const fake = new FakeHerdr();
    const adapter = fake.adapter();
    const terminal = await adapter.start(startOptions);
    fake.panes.delete("worker1:p1");
    fake.intercept = (argv) =>
      argv[1] === failedRead && argv.length === (failedRead === "get" ? 3 : 2)
        ? failure("unavailable")
        : undefined;
    await assert.rejects(adapter.destroy(terminal), code("unavailable"));
    assert.equal(fake.commands("workspace", "close").length, 0);
    fake.intercept = undefined;
    await adapter.destroy(terminal);
  }
});

test("a move racing workspace close retains ownership and does not follow the worker", async (t) => {
  environment(t);
  const fake = new FakeHerdr();
  const adapter = fake.adapter();
  const terminal = await adapter.start(startOptions);
  const moved = {
    ...info("external:p9", "external"),
    terminal_id: "terminal-worker1:p1",
  };
  fake.intercept = (argv) => {
    if (argv[0] !== "workspace" || argv[1] !== "close") return;
    fake.panes.delete("worker1:p1");
    fake.panes.set(moved.pane_id, moved);
    return ok({ type: "ok" });
  };
  await assert.rejects(adapter.destroy(terminal), code("terminal_not_stopped"));
  assert.equal(fake.commands("pane", "close").length, 0);
  fake.intercept = undefined;
  fake.panes.delete(moved.pane_id);
  await adapter.destroy(terminal);
});

test("changed terminal identity is never closed; inspect reports false", async (t) => {
  environment(t);
  const fake = new FakeHerdr();
  const adapter = fake.adapter();
  const terminal = await adapter.start(startOptions);
  const view = await adapter.open_view({ terminal, direction: "right" });
  const replacement = info("parent:p2", "parent");
  replacement.terminal_id = "external-terminal";
  fake.panes.set("parent:p2", replacement);
  await adapter.close_view(view);
  assert.equal(fake.commands("pane", "close").length, 0);
  const replacedWorker = info("worker1:p1", "worker1");
  replacedWorker.terminal_id = "another-external-terminal";
  fake.panes.set("worker1:p1", replacedWorker);
  assert.deepEqual(await adapter.inspect(terminal), { alive: false });
  await assert.rejects(
    adapter.destroy(terminal),
    code("workspace_contains_unowned_panes"),
  );
  assert.equal(fake.commands("workspace", "close").length, 0);
});

test("inspect handles missing panes but does not hide server errors", async (t) => {
  environment(t);
  const fake = new FakeHerdr();
  const adapter = fake.adapter();
  const terminal = await adapter.start(startOptions);
  fake.panes.delete("worker1:p1");
  assert.deepEqual(await adapter.inspect(terminal), { alive: false });
  fake.intercept = (argv) =>
    argv[1] === "get" ? failure("unavailable") : undefined;
  await assert.rejects(adapter.inspect(terminal), code("unavailable"));
});

test("layout changes prevent directional focus of an unrelated pane", async (t) => {
  environment(t);
  const fake = new FakeHerdr();
  const adapter = fake.adapter();
  const terminal = await adapter.start(startOptions);
  const view = await adapter.open_view({ terminal, direction: "right" });
  fake.neighbor = "external:p1";
  await assert.rejects(adapter.focus_view(view), code("view_layout_changed"));
  assert.equal(fake.commands("pane", "focus").length, 0);
});

test("outside Herdr and missing parent never start/attach implicitly", async (t) => {
  environment(t);
  const fake = new FakeHerdr();
  const adapter = fake.adapter();
  process.env.HERDR_ENV = "0";
  await assert.rejects(adapter.start(startOptions), code("not_in_herdr"));
  assert.equal(fake.calls.length, 0);
  process.env.HERDR_ENV = "1";
  const terminal = await adapter.start(startOptions);
  delete process.env.HERDR_PANE_ID;
  await assert.rejects(
    adapter.open_view({ terminal, direction: "down" }),
    code("missing_parent_pane"),
  );
  assert.equal(fake.commands("pane", "split").length, 0);
});

test("validates argv/env/limits before mutating anything", async (t) => {
  environment(t);
  const fake = new FakeHerdr();
  const adapter = fake.adapter();
  for (const options of [
    { ...startOptions, argv: [] },
    { ...startOptions, argv: ["pi\0oops"] },
    { ...startOptions, cwd: "--focus" },
  ]) {
    await assert.rejects(adapter.start(options), code("invalid_start"));
  }
  const invalidEnvs: Record<string, string>[] = [
    { "--focus": "1" },
    { TOKEN: "a\0b" },
  ];
  for (const env of invalidEnvs) {
    await assert.rejects(
      adapter.start({ ...startOptions, env }),
      code("invalid_env"),
    );
  }
  for (const timeoutMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => new HerdrAdapter({ timeoutMs }),
      code("invalid_limits"),
    );
  }
  assert.equal(fake.calls.length, 0);
});

test("malformed responses and nonzero exits are rejected without leaking output", async (t) => {
  environment(t);
  for (const response of [
    { exitCode: 0, stdout: "secret-token", stderr: "" },
    { exitCode: 0, stdout: "{}", stderr: "" },
    { exitCode: 0, stdout: "{broken", stderr: "" },
    { exitCode: 2, stdout: "", stderr: "secret-token" },
  ]) {
    const adapter = new HerdrAdapter({ runner: async () => response });
    await assert.rejects(adapter.start(startOptions), (error: unknown) => {
      assert.ok(error instanceof HerdrError);
      assert.ok(!String(error).includes("secret-token"));
      return true;
    });
  }
});

test("partial root response is rolled back when the known pane is owned", async (t) => {
  environment(t);
  const fake = new FakeHerdr();
  fake.intercept = (argv) => {
    if (argv[0] !== "workspace" || argv[1] !== "create") return;
    fake.panes.set("worker1:p1", info("worker1:p1", "worker1"));
    return ok({
      workspace: { workspace_id: "worker1" },
      root_pane: { pane_id: "worker1:p1" },
    });
  };
  await assert.rejects(
    fake.adapter().start(startOptions),
    code("invalid_response"),
  );
  assert.deepEqual(fake.commands("workspace", "close"), [
    ["workspace", "close", "worker1"],
  ]);
});

test("partial root response without a terminal ID retains a retryable workspace handle", async (t) => {
  environment(t);
  const fake = new FakeHerdr();
  fake.intercept = (argv) => {
    if (argv[0] === "workspace" && argv[1] === "create") {
      fake.panes.set("worker1:p1", info("worker1:p1", "worker1"));
      return ok({
        workspace: { workspace_id: "worker1" },
        root_pane: { pane_id: "worker1:p1" },
      });
    }
    if (argv[1] === "list") return failure("unavailable");
  };
  const adapter = fake.adapter();
  let terminal: TerminalHandle | undefined;
  await assert.rejects(adapter.start(startOptions), (error: unknown) => {
    assert.ok(error instanceof TerminalStartError);
    assert.ok(error.cause instanceof AggregateError);
    code("invalid_response")(error.cause.errors[0]);
    terminal = error.terminal;
    return true;
  });
  assert.ok(terminal);
  assert.equal(fake.commands("pane", "run").length, 0);
  fake.intercept = undefined;
  await adapter.destroy(terminal);
  assert.deepEqual(fake.commands("workspace", "close"), [
    ["workspace", "close", "worker1"],
  ]);
});

test("partial response without a terminal identity cannot forget an empty workspace", async (t) => {
  environment(t);
  const fake = new FakeHerdr();
  fake.intercept = (argv) =>
    argv[0] === "workspace" && argv[1] === "create"
      ? ok({
          workspace: { workspace_id: "worker1" },
          root_pane: { pane_id: "worker1:p1" },
        })
      : undefined;
  const adapter = fake.adapter();
  let terminal: TerminalHandle | undefined;
  await assert.rejects(adapter.start(startOptions), (error: unknown) => {
    assert.ok(error instanceof TerminalStartError);
    terminal = error.terminal;
    return true;
  });
  assert.ok(terminal);
  await assert.rejects(
    adapter.destroy(terminal),
    code("terminal_stop_unconfirmed"),
  );
  await assert.rejects(
    adapter.destroy(terminal),
    code("terminal_stop_unconfirmed"),
  );
  assert.equal(fake.commands("workspace", "close").length, 0);
});

test("rollback errors remain visible and do not permit closing foreign panes", async (t) => {
  environment(t);
  const fake = new FakeHerdr();
  fake.intercept = (argv) => {
    if (argv[1] !== "run") return;
    fake.panes.set("worker1:p9", info("worker1:p9", "worker1"));
    return failure("agent_not_ready");
  };
  const adapter = fake.adapter();
  let terminal: TerminalHandle | undefined;
  await assert.rejects(adapter.start(startOptions), (error: unknown) => {
    assert.ok(error instanceof TerminalStartError);
    assert.ok(error.cause instanceof AggregateError);
    assert.equal(error.cause.errors.length, 2);
    assert.ok(!String(error).includes("secret-token"));
    terminal = error.terminal;
    return true;
  });
  assert.equal(fake.commands("workspace", "close").length, 0);
  assert.ok(terminal);
  fake.panes.delete("worker1:p9");
  await adapter.destroy(terminal);
});

test("mock runner receives bounds and excessive combined output is rejected", async (t) => {
  environment(t);
  const adapter = new HerdrAdapter({
    timeoutMs: 100,
    maxOutputBytes: 20,
    runner: async (_file, _argv, options) => {
      assert.deepEqual(options, { timeoutMs: 100, maxOutputBytes: 20 });
      return { exitCode: 0, stdout: "x".repeat(11), stderr: "y".repeat(10) };
    },
  });
  await assert.rejects(adapter.start(startOptions), code("output_limit"));
  const throwing = new HerdrAdapter({
    runner: async () => {
      throw new Error("secret-token");
    },
  });
  await assert.rejects(throwing.start(startOptions), code("runner_failed"));
});

test("real runner uses argv without shell, enforces timeout/output bounds", async () => {
  const payload = "$(printf INJECTED); ' quotes and spaces";
  const output = await runHerdr(
    process.execPath,
    ["-e", "process.stdout.write(process.argv[1])", payload],
    { timeoutMs: 5_000, maxOutputBytes: 1024 },
  );
  assert.equal(output.stdout, payload);
  assert.equal(output.exitCode, 0);
  await assert.rejects(
    runHerdr(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], {
      timeoutMs: 100,
      maxOutputBytes: 1024,
    }),
    code("timeout"),
  );
  await assert.rejects(
    runHerdr(
      process.execPath,
      ["-e", "process.stdout.write('x'.repeat(4096))"],
      {
        timeoutMs: 5_000,
        maxOutputBytes: 100,
      },
    ),
    code("output_limit"),
  );
});

test("shutdown queued during attachment creation cleans the completed split", async (t) => {
  environment(t);
  const fake = new FakeHerdr();
  let notifySplit: () => void = () => {};
  let releaseSplit: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    notifySplit = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    releaseSplit = resolve;
  });
  const adapter = new HerdrAdapter({
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
  const opening = adapter.open_view({ terminal, direction: "right" });
  await started;
  const shutdown = adapter.destroy(terminal);
  assert.equal(fake.commands("workspace", "close").length, 0);
  releaseSplit();
  await Promise.all([opening, shutdown]);
  assert.deepEqual([...fake.panes.keys()], ["parent:p1", "external:p1"]);
  assert.deepEqual(fake.commands("pane", "close"), [
    ["pane", "close", "parent:p2"],
  ]);
});

test("manager shutdown awaiting an in-flight start can destroy its result", async (t) => {
  environment(t);
  const fake = new FakeHerdr();
  let notifyRun: () => void = () => {};
  let releaseRun: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    notifyRun = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    releaseRun = resolve;
  });
  const adapter = new HerdrAdapter({
    runner: async (file, argv, options) => {
      const result = await fake.runner(file, argv, options);
      if (argv[1] === "run") {
        notifyRun();
        await gate;
      }
      return result;
    },
  });
  const launching = adapter.start(startOptions);
  await started;
  const shutdown = launching.then((terminal) => adapter.destroy(terminal));
  releaseRun();
  await shutdown;
  assert.deepEqual([...fake.panes.keys()], ["parent:p1", "external:p1"]);
});
