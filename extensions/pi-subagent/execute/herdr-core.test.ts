import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildHerdrRunParams,
  buildHerdrSendParams,
  checkHerdrCoreEnv,
  createHerdrCoreExecutor,
  isHerdrViewAlive,
  parseHerdrRpcReply,
  parseHerdrTerminalStatus,
} from "./herdr-core.ts";
import { ExecutorError, type StartOptions } from "./index.ts";

const baseEnv: NodeJS.ProcessEnv = {
  HC_TERMINAL_ID: "tparent",
  HC_SOCKET: "/tmp/core socket",
  INHERITED: "original",
};

const startOptions: StartOptions = {
  agentId: "sub-1",
  agentType: "reviewer",
  cwd: "/tmp/work dir",
  argv: ["pi", "-e", "a 'b' \"c\" $HOME $(id)", ""],
  env: {
    WORKER_TOKEN: "tok",
    HC_TERMINAL_ID: "tspoof",
    INHERITED: "override",
  },
};

test("checkHerdrCoreEnv and executor check_env are pure and pin the supplied environment", () => {
  assert.equal(checkHerdrCoreEnv({ HC_TERMINAL_ID: "tparent" }), true);
  assert.equal(checkHerdrCoreEnv({}), false);
  assert.equal(checkHerdrCoreEnv({ HC_TERMINAL_ID: "   " }), false);

  const env: NodeJS.ProcessEnv = { HC_TERMINAL_ID: "tparent" };
  const executor = createHerdrCoreExecutor({ env });
  assert.equal(executor.check_env(), true);
  env.HC_TERMINAL_ID = "";
  assert.equal(executor.check_env(), true);
});

test("buildHerdrRunParams and buildHerdrSendParams preserve data, strip HC_TERMINAL_ID, and set labels", () => {
  const run = buildHerdrRunParams(
    startOptions,
    { ...baseEnv, EXTRA: "kept", EMPTY: undefined },
    "pi-fixed",
  );
  assert.deepEqual(run.argv, startOptions.argv);
  assert.equal(run.cwd, startOptions.cwd);
  assert.equal(run.name, "pi-fixed");
  assert.equal(run.caller, "tparent");
  assert.equal(run.parent, "tparent");
  const childEnv = run.env as Record<string, string>;
  assert.equal(childEnv.WORKER_TOKEN, "tok");
  assert.equal(childEnv.INHERITED, "override");
  assert.equal(childEnv.EXTRA, "kept");
  assert.equal("HC_TERMINAL_ID" in childEnv, false);
  assert.deepEqual(run.labels, {
    "pi-kits.subagent.id": "sub-1",
    "pi-kits.subagent.type": "reviewer",
  });

  assert.deepEqual(
    buildHerdrSendParams("t7", "Inspect x.ts", "tparent", { if: "working" }),
    {
      terminal: "t7",
      caller: "tparent",
      text: "Inspect x.ts",
      if: "working",
    },
  );
});

test("parseHerdrRpcReply, parseHerdrTerminalStatus, and isHerdrViewAlive are pure transformations", () => {
  assert.deepEqual(
    parseHerdrRpcReply(0, '{"jsonrpc":"2.0","id":1,"result":{"address":"t1"}}'),
    { address: "t1" },
  );
  assert.throws(
    () =>
      parseHerdrRpcReply(
        1,
        '{"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"missing","data":{"kind":"not_found"}}}',
      ),
    (err: unknown) => err instanceof ExecutorError && err.code === "not_found",
  );

  assert.deepEqual(parseHerdrTerminalStatus(undefined), { alive: false });
  assert.deepEqual(parseHerdrTerminalStatus({ state: "finished" }), {
    alive: false,
  });
  assert.deepEqual(
    parseHerdrTerminalStatus({
      state: "live",
      turn: 2,
      status: { state: "blocked", kind: "permission", msg: "Allow bash?" },
    }),
    {
      alive: true,
      state: "blocked",
      turn: 2,
      message: "Allow bash?",
      blockedKind: "permission",
    },
  );

  const view = { id: "tb1", terminalId: "t1", space: "spremote", tab: "tb1" };
  assert.equal(
    isHerdrViewAlive(
      {
        state: "live",
        labels: { "herdr.space": "spremote", "herdr.tab": "tb1" },
      },
      view,
    ),
    true,
  );
  assert.equal(
    isHerdrViewAlive(
      { state: "live", labels: { "herdr.space": "", "herdr.tab": "" } },
      view,
    ),
    false,
  );
});
