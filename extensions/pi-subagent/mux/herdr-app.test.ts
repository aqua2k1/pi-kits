import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createHerdrAppAdapter,
  HerdrAppError,
  type HerdrAppOptions,
  type HerdrAppRunner,
  type HerdrAppRunOptions,
  type HerdrAppRunResult,
} from "./herdr-app.ts";
import {
  type MuxAdapter,
  type StartOptions,
  type TerminalHandle,
  TerminalStartError,
} from "./index.ts";

const OWNER = "pi-kits.subagent.owner";
const binary = "/installed/hc with ' quotes";
const baseEnv = {
  HC_TERMINAL_ID: "tparent",
  HC_SOCKET: "/tmp/core socket",
  INHERITED: "original",
};
const startOptions: StartOptions = {
  agentId: "550e8400-e29b-41d4-a716-446655440000",
  agentType: "reviewer",
  cwd: "/tmp/work dir",
  argv: ["pi", "-e", "/tmp/worker.ts"],
  env: { WORKER_TOKEN: "worker-token" },
};

type Params = Record<string, unknown>;
interface Call {
  binary: string;
  argv: string[];
  options: HerdrAppRunOptions;
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

function reply(result: unknown): HerdrAppRunResult {
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
): HerdrAppRunResult {
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

class FakeCore {
  calls: Call[] = [];
  terminals = new Map<string, Facts>();
  document: {
    spaces: {
      id: string;
      tabs: { id: string; root: Params; [key: string]: unknown }[];
      [key: string]: unknown;
    }[];
    [key: string]: unknown;
  } = { spaces: [] };
  version = 1;
  parentLabels: Record<string, string> = { "herdr.space": "spremote" };
  intercept?: (call: Call) => HerdrAppRunResult | undefined;
  after?: (call: Call, result: HerdrAppRunResult) => HerdrAppRunResult;
  private next = 1;

  runner: HerdrAppRunner = async (file, argv, options) => {
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
    this.calls.push(call);
    const intercepted = this.intercept?.(call);
    if (intercepted) return intercepted;
    const result = this.execute(call);
    return this.after?.(call, result) ?? result;
  };

  publish(terminal = "t1"): void {
    const labels = this.facts(terminal).labels;
    let space = this.document.spaces.find(
      (entry) => entry.id === labels["herdr.space"],
    );
    if (!space) {
      space = { id: labels["herdr.space"], name: "Remote work", tabs: [] };
      this.document.spaces.push(space);
    }
    space.tabs.push({
      id: labels["herdr.tab"],
      name: "Task",
      root: { id: `p${terminal}`, type: "block", content: { terminal } },
    });
    this.version++;
  }

  private execute({ method, params }: Call): HerdrAppRunResult {
    if (method === "terminal.get" && params.terminal === "tparent") {
      return reply({ address: "tparent", labels: this.parentLabels });
    }
    if (method === "doc.get") {
      return reply({ value: this.document, version: this.version });
    }
    if (method === "doc.set") {
      assert.equal(params.name, "herdr-app");
      if (params.version !== this.version) return failure("conflict");
      this.document = structuredClone(params.value) as typeof this.document;
      return reply({ version: ++this.version });
    }
    if (method === "terminal.run") {
      const address = `t${this.next++}`;
      this.terminals.set(address, {
        address,
        name: params.name as string,
        labels: { ...(params.labels as Record<string, string>) },
        parent: params.parent as string,
        state: "live",
      });
      return reply({ address });
    }
    const terminal =
      this.terminals.get(params.terminal as string) ??
      [...this.terminals.values()].find(
        (item) => item.name === params.terminal,
      );
    if (!terminal) return failure();
    if (method === "terminal.get") return reply(terminal);
    assert.equal(params.terminal, terminal.address);
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
      this.terminals.delete(terminal.address);
      return reply({ removed: terminal.address });
    }
    assert.fail(`Unexpected RPC: ${method}`);
  }

  adapter(options: HerdrAppOptions = {}): MuxAdapter {
    return createHerdrAppAdapter({
      runner: this.runner,
      env: baseEnv,
      binPath: binary,
      ...options,
    });
  }

  methods(): string[] {
    return this.calls.map((call) => call.method);
  }

  facts(address = "t1"): Facts {
    const facts = this.terminals.get(address);
    assert.ok(facts);
    return facts;
  }
}

function code(expected: string) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof HerdrAppError);
    assert.equal(error.code, expected);
    return true;
  };
}

test("construction and check_env are CLI-free and pin the supplied environment", () => {
  const env: NodeJS.ProcessEnv = { HC_TERMINAL_ID: "tparent" };
  const adapter = createHerdrAppAdapter({
    env,
    runner: () => assert.fail("must not invoke hc"),
  });
  assert.equal(adapter.check_env(), true);
  env.HC_TERMINAL_ID = "";
  assert.equal(adapter.check_env(), true);
  assert.equal(createHerdrAppAdapter({ env: {} }).check_env(), false);
  assert.equal(
    createHerdrAppAdapter({ env: { HC_TERMINAL_ID: "   " } }).check_env(),
    false,
  );
});

test("start preserves argv/cwd/env as data, strips HC_TERMINAL_ID, and sets subagent labels", async () => {
  const fake = new FakeCore();
  const adapter = fake.adapter({
    env: { ...baseEnv, EXTRA: "kept", EMPTY: undefined },
  });
  const argv = ["pi", "-e", "a 'b' \"c\" $HOME $(id)", ""];
  const terminal = await adapter.start({
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
  assert.equal(run.no_notify, true);
  assert.equal(run.keep, false);
  assert.equal(run.rm, false);
  assert.equal(run.wait, false);
  const childEnv = run.env as Record<string, string>;
  assert.equal(childEnv.WORKER_TOKEN, "tok");
  assert.equal(childEnv.INHERITED, "override");
  assert.equal(childEnv.EXTRA, "kept");
  assert.equal("HC_TERMINAL_ID" in childEnv, false);
  assert.equal("EMPTY" in childEnv, false);
  const labels = run.labels as Record<string, string>;
  assert.equal(labels["pi-kits.subagent.id"], startOptions.agentId);
  assert.equal(labels["pi-kits.subagent.type"], "reviewer");
  assert.ok(labels[OWNER]);
});

test("inspect distinguishes live, finished, and missing terminals and surfaces RPC error details", async () => {
  const fake = new FakeCore();
  const adapter = fake.adapter();
  const terminal = await adapter.start(startOptions);
  assert.deepEqual(await adapter.inspect(terminal), { alive: true });
  fake.facts().state = "finished";
  assert.deepEqual(await adapter.inspect(terminal), { alive: false });
  fake.terminals.delete("t1");
  assert.deepEqual(await adapter.inspect(terminal), { alive: false });
  fake.intercept = () => failure("unavailable", "daemon restarting");
  await assert.rejects(adapter.inspect(terminal), (error: unknown) => {
    assert.ok(error instanceof HerdrAppError);
    assert.equal(error.code, "unavailable");
    assert.match(error.message, /daemon restarting/);
    return true;
  });
});

test("destroy kills and removes by immutable address, handles already-missing terminals, and retries failures", async () => {
  const fake = new FakeCore();
  const adapter = fake.adapter();
  const terminal = await adapter.start(startOptions);
  fake.calls.length = 0;
  await adapter.destroy(terminal);
  assert.deepEqual(fake.methods(), ["terminal.kill", "terminal.rm"]);
  assert.equal(fake.terminals.size, 0);
  await assert.rejects(adapter.destroy(terminal), code("unowned_terminal"));

  // Already-missing terminal succeeds idempotently.
  const second = await adapter.start(startOptions);
  fake.terminals.clear();
  await adapter.destroy(second);

  // Transient failure retains cleanup ownership for retry.
  const third = await adapter.start(startOptions);
  let failOnce = true;
  fake.intercept = (call) => {
    if (call.method === "terminal.kill" && failOnce) {
      failOnce = false;
      return failure("unavailable");
    }
  };
  await assert.rejects(adapter.destroy(third), code("unavailable"));
  await adapter.destroy(third);
  assert.equal(fake.terminals.size, 0);
});

test("uncertain launch retains a cleanup handle recovered by unique name; definitive rejection does not", async () => {
  const fake = new FakeCore();
  const adapter = fake.adapter();

  // Definitive rejection cleans up immediately without returning a TerminalStartError handle.
  fake.intercept = () => failure("invalid_params", "bad argv");
  await assert.rejects(adapter.start(startOptions), code("invalid_params"));

  // Timed-out launch after core created the terminal returns TerminalStartError for cleanup.
  fake.intercept = undefined;
  fake.after = (call, result) => {
    if (call.method === "terminal.run") throw new HerdrAppError("timeout");
    return result;
  };
  let handle: TerminalHandle | undefined;
  await assert.rejects(adapter.start(startOptions), (error: unknown) => {
    assert.ok(error instanceof TerminalStartError);
    code("timeout")(error.cause);
    handle = error.terminal;
    return true;
  });
  fake.after = undefined;
  assert.ok(handle);
  assert.equal(fake.terminals.size, 1);
  await adapter.destroy(handle);
  assert.equal(fake.terminals.size, 0);

  // If the timed-out launch hasn't appeared yet, destroy keeps ownership until it does.
  fake.intercept = () => {
    throw new HerdrAppError("timeout");
  };
  await assert.rejects(adapter.start(startOptions), (error: unknown) => {
    assert.ok(error instanceof TerminalStartError);
    handle = error.terminal;
    return true;
  });
  fake.intercept = undefined;
  await assert.rejects(
    adapter.destroy(handle as TerminalHandle),
    code("terminal_start_unconfirmed"),
  );
});

test("HC-only tab requests use parent space, confirm shared layout, and never focus a local app", async () => {
  const fake = new FakeCore();
  const warnings: string[] = [];
  const adapter = fake.adapter({ warn: (message) => warnings.push(message) });
  const terminal = await adapter.start(startOptions);
  const otherTerminal = await adapter.start(startOptions);
  const first = await adapter.open_view({ terminal });
  const second = await adapter.open_view({ terminal: otherTerminal });
  assert.notEqual(first.id, second.id);
  assert.equal(fake.facts("t1").labels["herdr.space"], "spremote");
  assert.equal(fake.facts("t2").labels["herdr.space"], "spremote");
  assert.notEqual(
    fake.facts("t1").labels["herdr.tab"],
    fake.facts("t2").labels["herdr.tab"],
  );
  assert.equal(fake.facts("t1").keep, true);
  await assert.rejects(
    adapter.inspect_view(first),
    code("view_change_unconfirmed"),
  );
  fake.publish("t1");
  fake.publish("t2");
  assert.deepEqual(await adapter.inspect_view(first), { alive: true });
  const beforeFocus = fake.calls.length;
  await adapter.focus_view(first);
  assert.equal(fake.calls.length, beforeFocus);
  assert.match(warnings.at(-1) ?? "", /Focus is local/);
  for (const view of [first, second]) {
    await adapter.close_view(view);
    const count = fake.calls.length;
    await adapter.close_view(view);
    assert.equal(fake.calls.length, count);
    assert.deepEqual(await adapter.inspect_view(view), { alive: false });
  }
  assert.equal(fake.document.spaces[0].tabs.length, 0);
  assert.equal(fake.facts().keep, false);
  assert.equal(fake.facts().labels["herdr.space"], "");
  assert.equal(fake.methods().includes("terminal.kill"), false);
});

test("pending requests cancel cleanly and moved placements are not followed", async () => {
  const fake = new FakeCore();
  const adapter = fake.adapter({ warn: () => {} });
  const terminal = await adapter.start(startOptions);
  const pending = await adapter.open_view({ terminal });
  await adapter.close_view(pending);
  assert.deepEqual(await adapter.inspect(terminal), { alive: true });
  assert.equal(fake.facts().keep, false);
  assert.equal(fake.methods().includes("doc.set"), false);

  const view = await adapter.open_view({ terminal });
  fake.publish();
  fake.facts().labels["herdr.tab"] = "tbforeign";
  assert.deepEqual(await adapter.inspect_view(view), { alive: false });
  fake.calls.length = 0;
  await adapter.close_view(view);
  assert.deepEqual(fake.methods(), ["terminal.get"]);
  assert.equal(fake.document.spaces[0].tabs.length, 1);
});

test("close retries CAS conflicts and preserves unrelated panes and document fields", async () => {
  const fake = new FakeCore();
  const adapter = fake.adapter({ warn: () => {} });
  const terminal = await adapter.start(startOptions);
  const view = await adapter.open_view({ terminal });
  fake.publish();
  const tab = fake.document.spaces[0].tabs[0];
  tab.root = {
    id: "row1",
    type: "row",
    children: [
      tab.root,
      { id: "external", type: "block", content: { terminal: "texternal" } },
    ],
  };
  fake.document.customField = { preserve: true };
  let conflicts = 1;
  fake.intercept = (call) => {
    if (call.method === "doc.set" && conflicts-- > 0) {
      fake.version++;
      return failure("conflict");
    }
  };
  await adapter.close_view(view);
  assert.deepEqual(fake.document.customField, { preserve: true });
  const remaining = fake.document.spaces[0].tabs[0].root as {
    children: { id: string }[];
  };
  assert.deepEqual(
    remaining.children.map((node) => node.id),
    ["external"],
  );
});

test("lost keep reply rolls back its placement and failed doc cleanup stays retryable", async () => {
  const fake = new FakeCore();
  const adapter = fake.adapter({ warn: () => {} });
  const terminal = await adapter.start(startOptions);
  let failKeep = true;
  fake.after = (call, result) => {
    if (
      call.method === "terminal.keep" &&
      call.params.keep === true &&
      failKeep
    ) {
      failKeep = false;
      fake.publish();
      throw new HerdrAppError("timeout");
    }
    return result;
  };
  await assert.rejects(adapter.open_view({ terminal }), code("timeout"));
  assert.equal(fake.facts().keep, false);
  assert.equal(fake.document.spaces[0].tabs.length, 0);

  const view = await adapter.open_view({ terminal });
  fake.publish();
  fake.intercept = (call) =>
    call.method === "doc.set" ? failure("unavailable") : undefined;
  await assert.rejects(adapter.close_view(view), code("unavailable"));
  fake.intercept = undefined;
  await adapter.destroy(terminal);
  await adapter.close_view(view);
  assert.equal(fake.document.spaces[0].tabs.length, 0);
});

test("foreign handles and invalid start/env options reject before RPC", async () => {
  const fake = new FakeCore();
  const adapter = fake.adapter({ warn: () => {} });
  const other = fake.adapter({ warn: () => {} });
  const terminal = await adapter.start(startOptions);
  fake.calls.length = 0;
  await assert.rejects(other.inspect(terminal), code("unowned_terminal"));
  await assert.rejects(other.destroy(terminal), code("unowned_terminal"));
  await assert.rejects(other.open_view({ terminal }), code("unowned_terminal"));
  await assert.rejects(
    other.close_view({ id: "foreign" }),
    code("unowned_view"),
  );
  assert.equal(fake.calls.length, 0);

  await assert.rejects(
    fake.adapter({ env: {} }).start(startOptions),
    code("not_in_herdr_app"),
  );
  await assert.rejects(
    adapter.start({ ...startOptions, cwd: "relative" }),
    code("invalid_start_options"),
  );
  fake.parentLabels = {};
  await assert.rejects(
    adapter.open_view({ terminal }),
    code("parent_space_unavailable"),
  );
});
