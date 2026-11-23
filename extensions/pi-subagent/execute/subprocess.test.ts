import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { ExecutorError } from "./index.ts";
import {
  createSubprocessExecutor,
  type SubprocessSpawner,
} from "./subprocess.ts";

function createFakeChild() {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    pid: 4321 as number | undefined,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    killedSignals: [] as string[],
    unreffed: false,
    unref() {
      this.unreffed = true;
    },
    kill(signal = "SIGTERM") {
      this.killedSignals.push(signal);
      this.exitCode = 0;
      emitter.emit("exit", 0, signal);
      return true;
    },
  });
}

test("subprocess executor spawns detached child and cleans up", async () => {
  const spawned: Array<{
    command: string;
    args: string[];
    cwd: string;
    env: NodeJS.ProcessEnv;
  }> = [];
  const children: ReturnType<typeof createFakeChild>[] = [];
  const spawner: SubprocessSpawner = (command, args, options) => {
    const child = createFakeChild();
    children.push(child);
    spawned.push({ command, args, cwd: options.cwd, env: options.env });
    return child as unknown as ChildProcess;
  };
  const executor = createSubprocessExecutor({
    spawn: spawner,
    env: { BASE_VAR: "kept" },
    graceMs: 10,
  });
  assert.equal(executor.id, "subprocess");
  assert.equal(executor.supportsView, false);
  assert.equal(executor.check_env(), true);

  const handle = await executor.start({
    agentId: "sub-1",
    agentType: "explorer",
    cwd: "/tmp/project",
    argv: ["pi", "--no-extensions", "-e", "/worker.ts"],
    env: { PI_KITS_SUBAGENT_WORKER: "1" },
  });
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].command, "pi");
  assert.deepEqual(spawned[0].args, ["--no-extensions", "-e", "/worker.ts"]);
  assert.equal(spawned[0].cwd, "/tmp/project");
  assert.equal(spawned[0].env.BASE_VAR, "kept");
  assert.equal(spawned[0].env.PI_KITS_SUBAGENT_WORKER, "1");
  assert.equal(children[0].unreffed, true);

  assert.deepEqual(await executor.inspect(handle), { alive: true });
  await executor.destroy(handle);
  await assert.rejects(executor.inspect(handle), (err: unknown) => {
    assert.ok(err instanceof ExecutorError);
    assert.equal(err.code, "unowned_terminal");
    return true;
  });
});
