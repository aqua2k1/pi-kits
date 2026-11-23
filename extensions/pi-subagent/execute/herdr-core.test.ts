import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createHerdrCoreExecutor,
  type HerdrCoreOptions,
  type HerdrCoreRunner,
  type HerdrCoreRunOptions,
  type HerdrCoreRunResult,
} from "./herdr-core.ts";
import { type Executor, ExecutorError, type StartOptions } from "./index.ts";

const binary = "/installed/hc with ' quotes";
const baseEnv = {
  HC_TERMINAL_ID: "tparent",
  HC_SOCKET: "/tmp/core socket",
  INHERITED: "original",
};
const startOptions: StartOptions = {
  agentId: "sub-1",
  agentType: "reviewer",
  cwd: "/tmp/work dir",
  argv: ["pi", "-e", "/tmp/worker.ts"],
  env: { WORKER_TOKEN: "worker-token" },
};

type Params = Record<string, unknown>;
interface Call {
  binary: string;
  argv: string[];
  options: HerdrCoreRunOptions;
  method: string;
  params: Params;
}
interface Facts {
  address: string;
  name: string;
  labels: Record<string, string>;
  parent: string;
  state: "live" | "finished";
  keep?: boolean;
}

function reply(result: unknown): HerdrCoreRunResult {
  return {
    exitCode: 0,
    stdout: `${JSON.stringify({ jsonrpc: "2.0", id: 1, result })}\n`,
    stderr: "",
  };
}

function failure(
  kind = "not_found",
  message = `mock ${kind}`,
  exitCode = 1,
): HerdrCoreRunResult {
  return {
    exitCode,
    stdout: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32000, message, data: { kind } },
    }),
    stderr: "",
  };
}

function createFakeCore() {
  const calls: Call[] = [];
  const terminals = new Map<string, Facts>();
  const parentLabels: Record<string, string> = { "herdr.space": "spremote" };
  let next = 1;

  const execute = ({ method, params }: Call): HerdrCoreRunResult => {
    if (method === "terminal.get" && params.terminal === "tparent") {
      return reply({ address: "tparent", labels: parentLabels });
    }
    if (method === "terminal.run") {
      const address = `t${next++}`;
      terminals.set(address, {
        address,
        name: params.name as string,
        labels: { ...(params.labels as Record<string, string>) },
        parent: params.parent as string,
        state: "live",
      });
      return reply({ address });
    }
    const terminal = terminals.get(params.terminal as string);
    if (!terminal) return failure();
    if (method === "terminal.get") return reply(terminal);
    if (method === "terminal.label") {
      Object.assign(terminal.labels, params.labels);
      return reply({});
    }
    if (method === "terminal.keep") {
      terminal.keep = params.keep as boolean;
      return reply({});
    }
    if (method === "terminal.kill") {
      terminal.state = "finished";
      return reply({});
    }
    if (method === "terminal.rm") {
      terminals.delete(terminal.address);
      return reply({ removed: terminal.address });
    }
    assert.fail(`Unexpected RPC: ${method}`);
  };

  const runner: HerdrCoreRunner = async (file, argv, options) => {
    assert.ok(options.input.endsWith("\n"));
    assert.deepEqual(argv, ["connect"]);
    const request = JSON.parse(options.input);
    const call: Call = {
      binary: file,
      argv: [...argv],
      options: { ...options, env: { ...options.env } },
      method: request.method,
      params: request.params,
    };
    calls.push(call);
    return execute(call);
  };

  return {
    calls,
    terminals,
    executor(options: HerdrCoreOptions = {}): Executor {
      return createHerdrCoreExecutor({
        runner,
        env: baseEnv,
        binPath: binary,
        ...options,
      });
    },
    methods(): string[] {
      return calls.map((call) => call.method);
    },
    facts(address = "t1"): Facts {
      const facts = terminals.get(address);
      assert.ok(facts);
      return facts;
    },
  };
}

function code(expected: string) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof ExecutorError);
    assert.equal(error.code, expected);
    return true;
  };
}

test("construction and check_env are CLI-free and pin the supplied environment", () => {
  const env: NodeJS.ProcessEnv = { HC_TERMINAL_ID: "tparent" };
  const executor = createHerdrCoreExecutor({
    env,
    runner: () => assert.fail("must not invoke hc"),
  });
  assert.equal(executor.check_env(), true);
  env.HC_TERMINAL_ID = "";
  assert.equal(executor.check_env(), true);
  assert.equal(createHerdrCoreExecutor({ env: {} }).check_env(), false);
  assert.equal(
    createHerdrCoreExecutor({ env: { HC_TERMINAL_ID: "   " } }).check_env(),
    false,
  );
});

test("start preserves argv/cwd/env as data, strips HC_TERMINAL_ID, and sets subagent labels", async () => {
  const fake = createFakeCore();
  const executor = fake.executor({
    env: { ...baseEnv, EXTRA: "kept", EMPTY: undefined },
  });
  const argv = ["pi", "-e", "a 'b' \"c\" $HOME $(id)", ""];
  const terminal = await executor.start({
    ...startOptions,
    argv,
    env: {
      WORKER_TOKEN: "tok",
      HC_TERMINAL_ID: "tspoof",
      INHERITED: "override",
    },
  });
  assert.deepEqual(Object.keys(terminal), ["id"]);
  assert.deepEqual(fake.methods(), ["terminal.run"]);
  const run = fake.calls[0].params;
  assert.deepEqual(run.argv, argv);
  assert.equal(run.cwd, startOptions.cwd);
  assert.equal(run.caller, "tparent");
  assert.equal(run.parent, "tparent");
  const childEnv = run.env as Record<string, string>;
  assert.equal(childEnv.WORKER_TOKEN, "tok");
  assert.equal(childEnv.INHERITED, "override");
  assert.equal(childEnv.EXTRA, "kept");
  assert.equal("HC_TERMINAL_ID" in childEnv, false);
  const labels = run.labels as Record<string, string>;
  assert.equal(labels["pi-kits.subagent.id"], startOptions.agentId);
  assert.equal(labels["pi-kits.subagent.type"], "reviewer");
});

test("destroy kills and removes by address and handles already-missing terminals", async () => {
  const fake = createFakeCore();
  const executor = fake.executor();
  const terminal = await executor.start(startOptions);
  fake.calls.length = 0;
  await executor.destroy(terminal);
  assert.deepEqual(fake.methods(), ["terminal.kill", "terminal.rm"]);
  assert.equal(fake.terminals.size, 0);
  await assert.rejects(executor.destroy(terminal), code("unowned_terminal"));
});

test("HC-only tab views use parent space labels, inspect via terminal.get, and clear labels on close", async () => {
  const fake = createFakeCore();
  const warnings: string[] = [];
  const executor = fake.executor({ warn: (message) => warnings.push(message) });
  const terminal = await executor.start(startOptions);
  assert.ok(
    executor.open_view &&
      executor.inspect_view &&
      executor.focus_view &&
      executor.close_view,
  );
  const view = await executor.open_view({ terminal });
  assert.equal(fake.facts("t1").labels["herdr.space"], "spremote");
  assert.ok(fake.facts("t1").labels["herdr.tab"]);
  assert.equal(fake.facts("t1").keep, true);
  assert.deepEqual(await executor.inspect_view(view), { alive: true });
  await executor.focus_view(view);
  assert.equal(warnings.length, 2);

  await executor.close_view(view);
  assert.equal(fake.facts("t1").labels["herdr.space"], "");
  assert.equal(fake.facts("t1").labels["herdr.tab"], "");
  assert.equal(fake.facts("t1").keep, false);
  assert.deepEqual(await executor.inspect_view(view), { alive: false });
  await executor.close_view(view);
});
