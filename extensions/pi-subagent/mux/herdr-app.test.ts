import assert from "node:assert/strict";
import { test } from "node:test";
import {
  HerdrAppAdapter,
  HerdrAppError,
  type HerdrAppOptions,
  type HerdrAppRunner,
  type HerdrAppRunOptions,
  type HerdrAppRunResult,
  runHerdrApp,
} from "./herdr-app.ts";
import {
  type StartOptions,
  type TerminalHandle,
  TerminalStartError,
} from "./index.ts";

const OWNER = "pi-kits.subagent.owner";
const SECRET = "secret-token $(touch SHOULD_NOT_EXIST)";
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
  env: { WORKER_TOKEN: SECRET },
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
}

function reply(result: unknown): HerdrAppRunResult {
  return {
    exitCode: 0,
    stdout: `${JSON.stringify({ jsonrpc: "2.0", id: 1, result })}\n`,
    stderr: "",
  };
}

function failure(kind = "not_found", exitCode = 1): HerdrAppRunResult {
  return {
    exitCode,
    stdout: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32000, message: SECRET, data: { kind } },
    }),
    stderr: SECRET,
  };
}

/** A core model, not a CLI mock: requests must arrive as JSON-RPC on stdin. */
class FakeCore {
  calls: Call[] = [];
  terminals = new Map<string, Facts>();
  intercept?: (call: Call) => HerdrAppRunResult | undefined;
  after?: (call: Call, result: HerdrAppRunResult) => HerdrAppRunResult;
  private next = 1;

  runner: HerdrAppRunner = async (file, argv, options) => {
    assert.ok(options.input.endsWith("\n"));
    assert.equal(options.input.trim().split("\n").length, 1);
    const request = JSON.parse(options.input);
    assert.equal(request.jsonrpc, "2.0");
    assert.equal(request.id, 1);
    assert.equal(typeof request.method, "string");
    assert.deepEqual(argv, ["connect"]);
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

  private execute({ method, params }: Call): HerdrAppRunResult {
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
    // Destructive operations must never follow mutable names.
    assert.equal(params.terminal, terminal.address);
    if (method === "terminal.kill") {
      terminal.state = "finished";
      return reply({});
    }
    if (method === "terminal.rm") {
      assert.equal(terminal.state, "finished");
      this.terminals.delete(terminal.address);
      return reply({ removed: terminal.address });
    }
    assert.fail(`Unexpected RPC: ${method}`);
  }

  adapter(options: HerdrAppOptions = {}): HerdrAppAdapter {
    return new HerdrAppAdapter({
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
    assert.equal(error.message, `Herdr app: ${expected}`);
    assert.ok(!String(error).includes(SECRET));
    return true;
  };
}

async function failedStart(
  adapter: HerdrAppAdapter,
  expected: string,
): Promise<TerminalHandle> {
  let terminal: TerminalHandle | undefined;
  await assert.rejects(adapter.start(startOptions), (error: unknown) => {
    assert.ok(error instanceof TerminalStartError);
    code(expected)(error.cause);
    assert.ok(!String(error).includes(SECRET));
    terminal = error.terminal;
    return true;
  });
  assert.ok(terminal);
  assert.deepEqual(Object.keys(terminal), ["id"]);
  return terminal;
}

test("construction/check_env are CLI-free and pin the supplied environment", () => {
  const fake = new FakeCore();
  for (const value of [undefined, "", " \t", "tparent", " tparent "]) {
    const env = { HC_TERMINAL_ID: value, HERDR_ENV: "1" };
    const adapter = fake.adapter({ env });
    assert.equal(adapter.check_env(), Boolean(value?.trim()));
    env.HC_TERMINAL_ID = value?.trim() ? "" : "tother";
    assert.equal(adapter.check_env(), Boolean(value?.trim()));
  }
  assert.deepEqual(fake.calls, []);
});

test("start preserves argv/cwd/env as data, owns labels, and never waits/notifies/removes", async () => {
  const fake = new FakeCore();
  const env = { ...baseEnv };
  const adapter = fake.adapter({ env });
  env.HC_TERMINAL_ID = "tother";
  env.INHERITED = "changed";
  const argv = [
    "worker with spaces",
    "$(printf INJECTED)",
    "'; printf INJECTED; #",
    "`printf INJECTED`",
    "a b\nc d",
    '"; & | < > * \\ $HOME',
    "",
  ];
  const cwd = "/tmp/a ' $(printf INJECTED)\nwork";
  const workerEnv = { INHERITED: "override", WORKER_TOKEN: SECRET };
  const terminal = await adapter.start({
    ...startOptions,
    argv,
    cwd,
    env: workerEnv,
  });
  assert.deepEqual(Object.keys(terminal), ["id"]);
  assert.notEqual(terminal.id, "t1");
  assert.deepEqual(fake.methods(), ["terminal.run", "terminal.get"]);
  const call = fake.calls[0];
  const { name, labels, ...params } = call.params;
  assert.match(name as string, /^pi-[a-z0-9]{29}$/);
  const ownedLabels = labels as Record<string, string>;
  assert.equal(typeof ownedLabels[OWNER], "string");
  assert.ok(ownedLabels[OWNER].length > 0);
  assert.deepEqual(ownedLabels, {
    [OWNER]: ownedLabels[OWNER],
    "pi-kits.subagent.id": startOptions.agentId,
    "pi-kits.subagent.type": "reviewer",
  });
  assert.deepEqual(params, {
    argv,
    cwd,
    env: {
      HC_SOCKET: baseEnv.HC_SOCKET,
      ...workerEnv,
    },
    caller: "tparent",
    parent: "tparent",
    no_notify: true,
    wait: false,
    keep: false,
    rm: false,
  });
  for (const recorded of fake.calls) {
    assert.equal(recorded.binary, binary);
    assert.deepEqual(recorded.argv, ["connect"]);
    assert.deepEqual(recorded.options.env, baseEnv);
    assert.equal(recorded.options.timeoutMs, 15_000);
    assert.equal(recorded.options.maxOutputBytes, 1024 * 1024);
  }
  await adapter.start({ ...startOptions, agentType: undefined });
  const second = fake.facts("t2");
  assert.ok(!("pi-kits.subagent.type" in second.labels));
  assert.notEqual(second.name, name);
  assert.notEqual(second.labels[OWNER], ownedLabels[OWNER]);
});

test("child env merges the snapshot, filters undefined, and cannot inherit or override HC_TERMINAL_ID", async () => {
  const fake = new FakeCore();
  const env = { ...baseEnv, UNDEFINED_VALUE: undefined };
  const adapter = fake.adapter({ env });
  env.INHERITED = "changed after construction";
  await adapter.start(startOptions);
  await adapter.start({
    ...startOptions,
    env: {
      ...startOptions.env,
      HC_TERMINAL_ID: "tspoofed",
      INHERITED: "override",
    },
  });
  const runs = fake.calls.filter((call) => call.method === "terminal.run");
  assert.deepEqual(
    runs.map((call) => call.params.env),
    [
      {
        HC_SOCKET: baseEnv.HC_SOCKET,
        INHERITED: "original",
        WORKER_TOKEN: SECRET,
      },
      {
        HC_SOCKET: baseEnv.HC_SOCKET,
        INHERITED: "override",
        WORKER_TOKEN: SECRET,
      },
    ],
  );
  for (const call of fake.calls) {
    // hc itself must still connect in the pinned parent context.
    assert.equal(call.options.env.HC_TERMINAL_ID, "tparent");
    assert.equal(call.options.env.INHERITED, "original");
  }
  for (const call of runs) {
    assert.equal(call.params.parent, "tparent");
    assert.equal(call.params.caller, "tparent");
    assert.ok(!("HC_TERMINAL_ID" in (call.params.env as Params)));
    assert.ok(!("UNDEFINED_VALUE" in (call.params.env as Params)));
  }
});

test("run followed by get not_found raises TerminalStartError and retains a cleanup handle", async () => {
  const fake = new FakeCore();
  const adapter = fake.adapter();
  let late: Facts | undefined;
  fake.after = (call, result) => {
    if (call.method === "terminal.run") {
      late = structuredClone(fake.facts());
      fake.terminals.delete("t1");
    }
    return result;
  };
  const terminal = await failedStart(adapter, "terminal_not_found_after_start");
  assert.deepEqual(fake.methods(), ["terminal.run", "terminal.get"]);
  assert.deepEqual(await adapter.inspect(terminal), { alive: false });
  await assert.rejects(
    adapter.destroy(terminal),
    code("terminal_start_unconfirmed"),
  );
  assert.ok(!fake.methods().includes("terminal.kill"));
  assert.ok(!fake.methods().includes("terminal.rm"));
  assert.ok(late);
  fake.terminals.set("t1", late);
  fake.after = undefined;
  await adapter.destroy(terminal);
  await assert.rejects(adapter.inspect(terminal), code("unowned_terminal"));
});

test("post-launch verification failures never discard the started terminal's cleanup handle", async (t) => {
  for (const reason of ["invalid_params", "binary_unavailable"]) {
    await t.test(reason, async () => {
      const fake = new FakeCore();
      const adapter = fake.adapter();
      fake.intercept = (call) => {
        if (call.method !== "terminal.get") return;
        if (reason === "binary_unavailable") throw new HerdrAppError(reason);
        return failure(reason);
      };
      const terminal = await failedStart(adapter, reason);
      assert.equal(fake.terminals.size, 1);
      fake.intercept = undefined;
      await adapter.destroy(terminal);
      assert.equal(fake.terminals.size, 0);
    });
  }
});

test("terminal handles are adapter-scoped; foreign operations make no RPC", async () => {
  const fake = new FakeCore();
  const owner = fake.adapter();
  const other = fake.adapter();
  const terminal = await owner.start(startOptions);
  const count = fake.calls.length;
  for (const handle of [terminal, { id: "t1" }, { id: "foreign" }]) {
    await assert.rejects(other.inspect(handle), code("unowned_terminal"));
    await assert.rejects(other.destroy(handle), code("unowned_terminal"));
    await assert.rejects(
      other.open_view({ terminal: handle, direction: "right" }),
      code("unowned_terminal"),
    );
  }
  assert.equal(fake.calls.length, count);
  assert.deepEqual(await owner.inspect(terminal), { alive: true });
});

test("inspect distinguishes live/finished/not_found without swallowing core failures", async () => {
  const fake = new FakeCore();
  const adapter = fake.adapter();
  const terminal = await adapter.start(startOptions);
  assert.deepEqual(await adapter.inspect(terminal), { alive: true });
  fake.facts().state = "finished";
  assert.deepEqual(await adapter.inspect(terminal), { alive: false });
  fake.terminals.delete("t1");
  assert.deepEqual(await adapter.inspect(terminal), { alive: false });
  fake.intercept = () => failure("unavailable");
  await assert.rejects(adapter.inspect(terminal), code("unavailable"));
});

test("destroy kills, confirms stopped identity, then removes by immutable address", async () => {
  const fake = new FakeCore();
  const adapter = fake.adapter();
  const terminal = await adapter.start(startOptions);
  fake.calls.length = 0;
  await adapter.destroy(terminal);
  assert.deepEqual(fake.methods(), [
    "terminal.get",
    "terminal.kill",
    "terminal.get",
    "terminal.rm",
  ]);
  assert.ok(fake.calls.every((call) => call.params.terminal === "t1"));
  assert.equal(fake.terminals.size, 0);
  await assert.rejects(adapter.inspect(terminal), code("unowned_terminal"));
  await assert.rejects(adapter.destroy(terminal), code("unowned_terminal"));
});

test("destroy handles already finished/missing terminals without killing", async (t) => {
  for (const state of ["finished", "missing"] as const) {
    await t.test(state, async () => {
      const fake = new FakeCore();
      const adapter = fake.adapter();
      const terminal = await adapter.start(startOptions);
      if (state === "finished") fake.facts().state = "finished";
      else fake.terminals.delete("t1");
      fake.calls.length = 0;
      await adapter.destroy(terminal);
      assert.deepEqual(fake.methods(), [
        "terminal.get",
        "terminal.get",
        ...(state === "finished" ? ["terminal.rm"] : []),
      ]);
      await assert.rejects(adapter.inspect(terminal), code("unowned_terminal"));
    });
  }
});

test("changed address/owner/parent never authorize kill or rm, including after kill", async (t) => {
  for (const field of ["address", "owner", "parent"] as const) {
    for (const phase of ["before", "after"] as const) {
      await t.test(`${field} ${phase}`, async () => {
        const fake = new FakeCore();
        const adapter = fake.adapter();
        const terminal = await adapter.start(startOptions);
        const original = structuredClone(fake.facts());
        const changeIdentity = () => {
          const facts = fake.facts();
          if (field === "owner") facts.labels[OWNER] = "foreign-owner";
          else facts[field] = field === "address" ? "tforeign" : "tother";
        };
        if (phase === "before") changeIdentity();
        else {
          fake.after = (call, result) => {
            if (call.method === "terminal.kill") changeIdentity();
            return result;
          };
        }
        fake.calls.length = 0;
        await assert.rejects(
          adapter.destroy(terminal),
          code("terminal_identity_changed"),
        );
        assert.equal(fake.methods().includes("terminal.rm"), false);
        assert.equal(
          fake.methods().includes("terminal.kill"),
          phase === "after",
        );
        fake.after = undefined;
        fake.terminals.set("t1", original);
        await adapter.destroy(terminal);
      });
    }
  }
});

test("failed kill/confirmation/rm retain cleanup ownership for retry", async (t) => {
  for (const mode of ["kill", "still_live", "confirm", "rm", "rm_reply"]) {
    await t.test(mode, async () => {
      const fake = new FakeCore();
      const adapter = fake.adapter();
      const terminal = await adapter.start(startOptions);
      let killed = false;
      fake.intercept = (call) => {
        if (call.method === "terminal.kill") {
          if (mode === "kill") return failure("unavailable");
          killed = true;
          if (mode === "still_live") return reply({});
        }
        if (mode === "confirm" && killed && call.method === "terminal.get") {
          return failure("unavailable");
        }
        if (call.method === "terminal.rm") {
          if (mode === "rm") return failure("unavailable");
          if (mode === "rm_reply") return reply({ removed: "tforeign" });
        }
      };
      fake.calls.length = 0;
      await assert.rejects(
        adapter.destroy(terminal),
        code(
          mode === "still_live"
            ? "terminal_not_stopped"
            : mode === "rm_reply"
              ? "invalid_response"
              : "unavailable",
        ),
      );
      if (["kill", "still_live", "confirm"].includes(mode)) {
        assert.ok(!fake.methods().includes("terminal.rm"));
      }
      fake.intercept = undefined;
      await adapter.destroy(terminal);
      assert.equal(fake.terminals.size, 0);
      await assert.rejects(adapter.inspect(terminal), code("unowned_terminal"));
    });
  }
});

test("lost launch reply returns a cleanup handle; unique name recovers only its worker", async (t) => {
  for (const reason of ["timeout", "output_limit", "invalid_response"]) {
    await t.test(reason, async () => {
      const fake = new FakeCore();
      const adapter = fake.adapter();
      const other = await adapter.start(startOptions);
      const otherFacts = structuredClone(fake.facts());
      fake.after = (call, result) => {
        if (call.method !== "terminal.run") return result;
        if (reason === "invalid_response") {
          return { exitCode: 0, stdout: SECRET, stderr: "" };
        }
        throw new HerdrAppError(reason);
      };
      const terminal = await failedStart(adapter, reason);
      const run = fake.calls.findLast((call) => call.method === "terminal.run");
      assert.ok(run);
      assert.notEqual(run.params.name, otherFacts.name);
      fake.after = undefined;
      let unavailable = true;
      fake.intercept = (call) =>
        unavailable && call.method === "terminal.get"
          ? failure("unavailable")
          : undefined;
      await assert.rejects(adapter.destroy(terminal), code("unavailable"));
      unavailable = false;
      fake.calls.length = 0;
      await adapter.destroy(terminal);
      assert.deepEqual(
        fake.calls.map((call) => call.params.terminal),
        [run.params.name, "t2", "t2", "t2"],
      );
      assert.deepEqual(fake.facts(), otherFacts);
      assert.equal(fake.terminals.size, 1);
      await adapter.destroy(other);
    });
  }
});

test("an uncertain launch cannot be forgotten before its late terminal appears", async () => {
  const fake = new FakeCore();
  const adapter = fake.adapter();
  fake.intercept = (call) => {
    if (call.method === "terminal.run") throw new HerdrAppError("timeout");
  };
  const terminal = await failedStart(adapter, "timeout");
  const run = fake.calls[0];
  await assert.rejects(
    adapter.destroy(terminal),
    code("terminal_start_unconfirmed"),
  );
  assert.ok(!fake.methods().includes("terminal.kill"));
  fake.terminals.set("tlate", {
    address: "tlate",
    name: run.params.name as string,
    labels: run.params.labels as Record<string, string>,
    parent: run.params.parent as string,
    state: "live",
  });
  fake.intercept = undefined;
  await adapter.destroy(terminal);
  assert.equal(fake.terminals.size, 0);
});

test("definitive launch rejections and missing binaries do not leave cleanup blocked", async (t) => {
  for (const reason of ["invalid_params", "binary_unavailable"]) {
    await t.test(reason, async () => {
      const fake = new FakeCore();
      const adapter = fake.adapter();
      fake.intercept = (call) => {
        if (call.method !== "terminal.run") return;
        if (reason === "binary_unavailable") throw new HerdrAppError(reason);
        return failure(reason);
      };
      await assert.rejects(adapter.start(startOptions), code(reason));
      assert.deepEqual(fake.methods(), ["terminal.run"]);
      fake.intercept = undefined;
      const terminal = await adapter.start(startOptions);
      await adapter.destroy(terminal);
      assert.equal(fake.terminals.size, 0);
    });
  }
});

test("malformed success and uncertain server errors retain late launch cleanup", async (t) => {
  for (const mode of ["invalid_success", "unknown_error", "spawn_failed"]) {
    await t.test(mode, async () => {
      const fake = new FakeCore();
      const adapter = fake.adapter();
      let late: Facts | undefined;
      fake.after = (call, result) => {
        if (call.method !== "terminal.run") return result;
        late = structuredClone(fake.facts());
        fake.terminals.delete("t1");
        return mode === "invalid_success"
          ? reply({})
          : failure(mode === "unknown_error" ? "unexpected" : mode);
      };
      const terminal = await failedStart(
        adapter,
        mode === "invalid_success"
          ? "invalid_response"
          : mode === "unknown_error"
            ? "server_error"
            : mode,
      );
      await assert.rejects(
        adapter.destroy(terminal),
        code("terminal_start_unconfirmed"),
      );
      assert.ok(late);
      fake.terminals.set("t1", late);
      fake.after = undefined;
      await adapter.destroy(terminal);
      assert.equal(fake.terminals.size, 0);
    });
  }
});

test("unsupported relative views only warn: no RPC/window fallback, false inspection, idempotent close", async (t) => {
  for (const throwing of [false, true]) {
    await t.test(`throwing warning sink: ${throwing}`, async () => {
      const fake = new FakeCore();
      const warnings: string[] = [];
      const adapter = fake.adapter({
        warn(message) {
          warnings.push(message);
          if (throwing) throw new Error("notification sink failed");
        },
      });
      const terminal = await adapter.start(startOptions);
      const count = fake.calls.length;
      const first = await adapter.open_view({ terminal, direction: "right" });
      const second = await adapter.open_view({
        terminal,
        direction: "down",
        relativeTo: first,
      });
      assert.notEqual(first.id, second.id);
      assert.deepEqual(Object.keys(first), ["id"]);
      for (const view of [first, second]) {
        assert.deepEqual(await adapter.inspect_view(view), { alive: false });
        await adapter.focus_view(view);
        await adapter.close_view(view);
        const warned = warnings.length;
        await adapter.close_view(view);
        assert.equal(warnings.length, warned);
        assert.deepEqual(await adapter.inspect_view(view), { alive: false });
      }
      assert.equal(fake.calls.length, count);
      assert.equal(warnings.length, 6);
      for (const warning of warnings) {
        assert.match(warning, /unavailable/);
        assert.match(warning, /no window changes/);
        assert.ok(!warning.includes(SECRET));
      }
      const other = fake.adapter();
      for (const view of [first, { id: "foreign" }]) {
        await assert.rejects(other.inspect_view(view), code("unowned_view"));
        await assert.rejects(other.focus_view(view), code("unowned_view"));
        await assert.rejects(other.close_view(view), code("unowned_view"));
      }
      assert.equal(fake.calls.length, count);
      await adapter.destroy(terminal);
    });
  }
});

test("invalid environment/start options and runner limits are rejected before RPC", async () => {
  const fake = new FakeCore();
  await assert.rejects(
    fake.adapter({ env: {} }).start(startOptions),
    code("not_in_herdr_app"),
  );
  await assert.rejects(
    fake
      .adapter({ env: { HC_TERMINAL_ID: "parent;evil" } })
      .start(startOptions),
    code("invalid_response"),
  );
  const adapter = fake.adapter();
  for (const options of [
    { ...startOptions, argv: [] },
    { ...startOptions, argv: [""] },
    { ...startOptions, argv: ["pi", "bad\0arg"] },
    { ...startOptions, cwd: "relative/path" },
    { ...startOptions, env: { "BAD-NAME": "value" } },
    { ...startOptions, env: { TOKEN: "bad\0value" } },
  ]) {
    await assert.rejects(adapter.start(options), code("invalid_start_options"));
  }
  for (const key of ["timeoutMs", "maxOutputBytes"] as const) {
    for (const value of [
      0,
      -1,
      0.5,
      NaN,
      Infinity,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      assert.throws(
        () => fake.adapter({ [key]: value }),
        code("invalid_limits"),
      );
    }
  }
  assert.deepEqual(fake.calls, []);
});

test("runner exceptions, malformed RPC, and CLI errors are sanitized", async (t) => {
  const cases: [string, () => HerdrAppRunResult][] = [
    [
      "runner_failed",
      () => {
        throw new Error(SECRET);
      },
    ],
    [
      "timeout",
      () => {
        throw new HerdrAppError("timeout");
      },
    ],
    [
      "invalid_response",
      () => ({ exitCode: 0, stdout: SECRET, stderr: SECRET }),
    ],
    ["cli_failed", () => ({ exitCode: 2, stdout: SECRET, stderr: SECRET })],
    ["invalid_response", () => reply(null)],
    ["invalid_response", () => reply([])],
    [
      "invalid_response",
      () => ({ ...reply({}), stdout: '{"jsonrpc":"2.0","id":2,"result":{}}' }),
    ],
    [
      "invalid_response",
      () => ({ ...reply({}), stdout: '{"id":1,"result":{}}' }),
    ],
    ["cli_failed", () => ({ ...reply({ address: "t1" }), exitCode: 2 })],
    ["server_error", () => failure(SECRET)],
    ["server_error", () => failure("a".repeat(64))],
    ["server_error", () => failure("plausible_but_unknown_secret")],
    ["unavailable", () => failure("unavailable", 0)],
    ["unavailable", () => failure("unavailable", 1)],
    ["invalid_response", () => reply({ address: "name-not-address" })],
  ];
  for (const [index, [expected, result]] of cases.entries()) {
    await t.test(`${index}: ${expected}`, async () => {
      const adapter = new HerdrAppAdapter({
        env: baseEnv,
        runner: async () => result(),
      });
      await failedStart(adapter, expected);
    });
  }
});

test("runner receives custom bounds; combined UTF-8 stdout/stderr bytes are limited", async () => {
  const fake = new FakeCore();
  const adapter = fake.adapter({ timeoutMs: 123, maxOutputBytes: 512 });
  await adapter.start(startOptions);
  assert.ok(fake.calls.every((call) => call.options.timeoutMs === 123));
  assert.ok(fake.calls.every((call) => call.options.maxOutputBytes === 512));
  const bounded = fake.adapter({
    timeoutMs: 123,
    maxOutputBytes: 20,
    runner: async (_binary, _argv, options) => {
      assert.equal(options.timeoutMs, 123);
      assert.equal(options.maxOutputBytes, 20);
      return { exitCode: 0, stdout: "界".repeat(4), stderr: "界".repeat(3) };
    },
  });
  await failedStart(bounded, "output_limit");
});

function processOptions(
  overrides: Partial<HerdrAppRunOptions> = {},
): HerdrAppRunOptions {
  return {
    timeoutMs: 5_000,
    maxOutputBytes: 4096,
    env: { ...process.env, TEST_TOKEN: SECRET },
    input: '{"jsonrpc":"2.0","id":1,"method":"test","params":{}}\n',
    ...overrides,
  };
}

test("real runner preserves argv/env and keeps stdin open until a newline reply", async () => {
  const payload = "$(printf INJECTED); ' quotes and spaces";
  const options = processOptions();
  const script = `
    let input = '';
    let replied = false;
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => {
      input += chunk;
      if (!input.includes('\\n') || replied) return;
      setTimeout(() => {
        replied = true;
        process.stdout.write(JSON.stringify({
          input, arg: process.argv[1], token: process.env.TEST_TOKEN
        }) + '\\n');
      }, 30);
    });
    process.stdin.on('end', () => { if (!replied) process.exit(9); });
  `;
  const output = await runHerdrApp(
    process.execPath,
    ["-e", script, payload],
    options,
  );
  assert.equal(output.exitCode, 0);
  assert.equal(output.stderr, "");
  assert.deepEqual(JSON.parse(output.stdout), {
    input: options.input,
    arg: payload,
    token: SECRET,
  });
});

test("real runner sanitizes spawn failure/timeout/overflow and preserves numeric exit codes", async () => {
  const exited = await runHerdrApp(
    process.execPath,
    [
      "-e",
      "process.stderr.write(process.env.TEST_TOKEN); process.exitCode = 7",
    ],
    processOptions(),
  );
  assert.deepEqual(exited, { exitCode: 7, stdout: "", stderr: SECRET });
  await assert.rejects(
    runHerdrApp("/nonexistent/pi-kits-test-hc", [], processOptions()),
    code("binary_unavailable"),
  );
  await assert.rejects(
    runHerdrApp(
      process.execPath,
      ["-e", "setTimeout(() => {}, 10000)"],
      processOptions({ timeoutMs: 100 }),
    ),
    code("timeout"),
  );
  for (const stream of ["stdout", "stderr"]) {
    await assert.rejects(
      runHerdrApp(
        process.execPath,
        ["-e", `process.${stream}.write('x'.repeat(8192))`],
        processOptions({ maxOutputBytes: 100 }),
      ),
      code("output_limit"),
    );
  }
});

test("real runner applies maxOutputBytes to combined stdout and stderr", async () => {
  await assert.rejects(
    runHerdrApp(
      process.execPath,
      [
        "-e",
        "process.stdout.write('x'.repeat(60)); process.stderr.write('y'.repeat(60))",
      ],
      processOptions({ maxOutputBytes: 100 }),
    ),
    code("output_limit"),
  );
});
