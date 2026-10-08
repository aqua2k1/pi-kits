import assert from "node:assert/strict";
import { once } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { type TestContext, test } from "node:test";
import type { AgentDefinition } from "../../agents.ts";
import type { MuxAdapter, StartOptions } from "../../mux/index.ts";
import type { RuntimeCommand, RuntimeOptions } from "../index.ts";
import { PiRuntime } from "./index.ts";

const agent: AgentDefinition = {
  name: "test",
  description: "Test",
  systemPrompt: "Keep the original role.",
  model: "agent/model",
  thinking: "high",
  enabled: true,
  source: "project",
  sourcePath: "/agents/test.md",
};

async function launch(t: TestContext, options: Partial<RuntimeOptions> = {}) {
  let socket: Socket | undefined;
  let started: StartOptions | undefined;
  const mux = {
    async start(value: StartOptions) {
      started = value;
      const [host, port] = value.env.PI_KITS_SUBAGENT_ENDPOINT.split(":");
      socket = createConnection({ host, port: Number(port) });
      socket.setEncoding("utf8");
      await once(socket, "connect");
      socket.write(
        `${JSON.stringify({
          type: "ready",
          id: value.agentId,
          token: value.env.PI_KITS_SUBAGENT_TOKEN,
        })}\n`,
      );
      return { id: "terminal" };
    },
    async destroy() {
      socket?.destroy();
    },
  } as unknown as MuxAdapter;
  const runtime = new PiRuntime();
  const session = runtime.create(
    {
      id: "cli-test",
      cwd: "/tmp",
      extensionAllowlist: [],
      startupTimeoutMs: 2_000,
      ...options,
    },
    { mux, emit() {} },
  );
  t.after(() => session.close());
  await session.start();
  assert.ok(started);
  assert.ok(socket);
  return { runtime, session, started, socket };
}

function argument(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index === -1 ? undefined : argv[index + 1];
}

test("Pi CLI uses normalized session tools, denies, model and thinking for unnamed sessions", async (t) => {
  const { started } = await launch(t, {
    executable: "custom-pi",
    workerPath: "/custom/worker.ts",
    model: "parent/model",
    thinking: "max",
    runtimeConfig: {
      tools: " read, codemode, read ",
      disallowed_tools: [" write ", "write", "bash"],
      runtime_args: [false],
      review_target: null,
    },
  });
  assert.deepEqual(started.argv, [
    "custom-pi",
    "--no-extensions",
    "-e",
    "/custom/worker.ts",
    "--session-id",
    "subagent-cli-test",
    "--model",
    "parent/model",
    "--thinking",
    "max",
    "--tools",
    "read,codemode",
    "--exclude-tools",
    "write,bash",
  ]);
});

test("Pi forwards the task cwd to mux startup", async (t) => {
  const cwd = "/tmp/child workspace";
  const { started } = await launch(t, { cwd });
  assert.equal(started.cwd, cwd);
});

test("Pi CLI sets the native session name when provided", async (t) => {
  const { started } = await launch(t, {
    sessionName: "Sub · explorer · Inspect auth",
  });
  assert.equal(
    argument(started.argv, "--name"),
    "Sub · explorer · Inspect auth",
  );
});

test("Pi rejects prompt mode for unnamed sessions instead of ignoring it", () => {
  const runtime = new PiRuntime();
  for (const prompt_mode of ["replace", "append"]) {
    const options = {
      id: "unnamed",
      cwd: "/tmp",
      runtimeConfig: { prompt_mode },
    };
    assert.throws(
      () => runtime.validate(options),
      /requires a named agent body/,
    );
    assert.throws(
      () => runtime.create(options, { mux: {} as MuxAdapter, emit() {} }),
      /requires a named agent body/,
    );
  }
});

test("Pi CLI defaults named agents to replace, keeping the blank append override", async (t) => {
  const { session, started } = await launch(t, {
    agent: {
      ...agent,
      runtimeConfig: { tools: "bash", prompt_mode: "append" },
    },
    runtimeConfig: {
      tools: ["read", "codemode"],
      disallowed_tools: "codemode",
    },
    model: "parent/model",
    thinking: "max",
  });
  const argv = started.argv;
  assert.equal(argument(argv, "--model"), "agent/model");
  assert.equal(argument(argv, "--thinking"), "high");
  assert.equal(argument(argv, "--tools"), "read,codemode");
  assert.equal(argument(argv, "--exclude-tools"), "codemode");
  const systemPath = argument(argv, "--system-prompt");
  const appendPath = argument(argv, "--append-system-prompt");
  assert.ok(systemPath);
  assert.ok(appendPath);
  assert.equal(readFileSync(systemPath, "utf8"), agent.systemPrompt);
  assert.equal(readFileSync(appendPath, "utf8"), "");
  await session.close();
  assert.equal(existsSync(systemPath), false);
  assert.equal(existsSync(appendPath), false);
});

test("Pi CLI reads named runtime config and append mode without a replacement flag", async (t) => {
  const { started } = await launch(t, {
    agent: {
      ...agent,
      systemPrompt: "",
      runtimeConfig: { tools: "none", prompt_mode: " append " },
    },
  });
  assert.equal(started.argv.includes("--no-tools"), true);
  assert.equal(started.argv.includes("--tools"), false);
  assert.equal(started.argv.includes("--system-prompt"), false);
  const appendPath = argument(started.argv, "--append-system-prompt");
  assert.ok(appendPath);
  assert.equal(readFileSync(appendPath, "utf8"), "");
});

test("Pi CLI preserves omitted tools and distinguishes explicit empty lists", async (t) => {
  for (const runtimeConfig of [{}, { disallowed_tools: "bash" }]) {
    const { session, started } = await launch(t, { runtimeConfig });
    assert.equal(started.argv.includes("--tools"), false);
    assert.equal(started.argv.includes("--no-tools"), false);
    assert.equal(
      argument(started.argv, "--exclude-tools"),
      runtimeConfig.disallowed_tools,
    );
    await session.close();
  }
  for (const tools of [[], "", "none"]) {
    const { session, started } = await launch(t, {
      runtimeConfig: { tools, disallowed_tools: [] },
    });
    assert.equal(started.argv.includes("--no-tools"), true);
    assert.equal(started.argv.includes("--tools"), false);
    assert.equal(started.argv.includes("--exclude-tools"), false);
    await session.close();
  }
});

test("PiSession send normalizes tools and strips foreign task config without bypassing prompt validation", async (t) => {
  const { session, socket } = await launch(t, {
    runtimeConfig: { tools: "read, bash, read", disallowed_tools: "bash" },
  });
  const received = once(socket, "data");
  const command: RuntimeCommand = {
    type: "task",
    prompt: "Inspect files",
    round: 2,
    instructions: { systemPrompt: "Keep instructions" },
  };
  assert.throws(
    () => session.send({ type: "task", prompt: " " }),
    /must not be blank/,
  );
  const runtimeParams = {
    tools: false,
    review_target: null,
    future_option: [false],
  };
  session.send({ ...command, runtimeParams });
  const [frame] = await received;
  assert.deepEqual(JSON.parse(String(frame).trim()), {
    ...command,
    instructions: { systemPrompt: "Keep instructions", tools: ["read"] },
  });
  assert.deepEqual(command.instructions, { systemPrompt: "Keep instructions" });
  assert.deepEqual(runtimeParams, {
    tools: false,
    review_target: null,
    future_option: [false],
  });
});

test("PiSession send strips foreign task params without adding tools when tools are omitted", async (t) => {
  const { session, socket } = await launch(t);
  const received = once(socket, "data");
  session.send({
    type: "task",
    prompt: "Inspect files",
    runtimeParams: { prompt_mode: false, inherit_context: "invalid" },
  });
  const [frame] = await received;
  assert.deepEqual(JSON.parse(String(frame).trim()), {
    type: "task",
    prompt: "Inspect files",
  });
});
