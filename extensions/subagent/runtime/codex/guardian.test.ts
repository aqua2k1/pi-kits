import assert from "node:assert/strict";
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { spawnCodexGuardian } from "./guardian.ts";

const posix = { skip: process.platform === "win32", timeout: 10_000 };
const entry = new URL("./guardian.mjs", import.meta.url);
const helper = new URL("./guardian.ts", import.meta.url).href;
type Pids = { backend: number; tool: number; worker: string; ipc: boolean };

async function until(check: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error("Process test timed out");
    await delay(20);
  }
}

async function alive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    // Orphans may be zombies until the host's init reaps them. Zombies cannot
    // execute tools and are not live resources; do not depend on init timing.
    if (process.platform === "linux") {
      const stat = await readFile(`/proc/${pid}/stat`, "utf8");
      return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0] !== "Z";
    }
    return !execFileSync("ps", ["-o", "stat=", "-p", String(pid)])
      .toString()
      .trim()
      .startsWith("Z");
  } catch {
    return false;
  }
}

function group(pid: number): number {
  return Number(
    execFileSync("ps", ["-o", "pgid=", "-p", String(pid)])
      .toString()
      .trim(),
  );
}

async function fixture(t: TestContext, exitBackend = false) {
  const dir = await mkdtemp(join(tmpdir(), "codex-guardian-test-"));
  const ready = join(dir, "ready.json");
  const backend = join(dir, "backend.mjs");
  // Fake app-server and fake native tool work only: never invoke Codex/Herdr.
  await writeFile(
    backend,
    `import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
process.on("SIGTERM", () => {});
const tool = spawn(process.execPath, ["-e", ${JSON.stringify('process.on("SIGTERM", () => {}); process.send("ready"); setInterval(() => {}, 1000);')}], {
  stdio: ["ignore", "ignore", "inherit", "ipc"]
});
tool.once("message", () => {
  writeFileSync(${JSON.stringify(ready)}, JSON.stringify({
    backend: process.pid, tool: tool.pid,
    worker: process.env.PI_KITS_SUBAGENT_WORKER, ipc: !!process.send
  }));
  ${exitBackend ? "process.exit(7);" : "setInterval(() => {}, 1000);"}
});
`,
  );
  let guardian: ChildProcess | undefined;
  let owner: ChildProcess | undefined;
  let pids: Pids | undefined;
  t.after(async () => {
    owner?.kill("SIGKILL");
    if (guardian?.exitCode === null && guardian.signalCode === null) {
      const exited = once(guardian, "exit");
      guardian.kill("SIGKILL");
      await exited;
    }
    // Also clean up if an assertion failed before the parent's death test.
    if (pids) {
      for (const pid of [pids.backend, pids.tool]) {
        if (await alive(pid)) process.kill(pid, "SIGKILL");
      }
    }
    await rm(dir, { recursive: true, force: true });
  });
  return {
    dir,
    backend,
    setGuardian(child: ChildProcess) {
      guardian = child;
      child.stderr?.resume();
    },
    setOwner(child: ChildProcess) {
      owner = child;
      child.stderr?.resume();
    },
    async ready(): Promise<Pids> {
      await until(async () => {
        try {
          pids = JSON.parse(await readFile(ready, "utf8")) as Pids;
          return true;
        } catch {
          return false;
        }
      });
      assert.ok(pids);
      return pids;
    },
  };
}

for (const signal of ["SIGTERM", "SIGKILL"] as const) {
  test(`${signal} kills resistant tools`, posix, async (t) => {
    const f = await fixture(t);
    const guardian = spawnCodexGuardian(process.execPath, [f.backend], f.dir);
    f.setGuardian(guardian);
    const pids = await f.ready();
    assert.ok(guardian.pid);
    assert.equal(group(guardian.pid), guardian.pid);
    assert.equal(group(pids.backend), guardian.pid);
    assert.equal(group(pids.tool), guardian.pid);
    assert.notEqual(group(process.pid), guardian.pid);
    assert.equal(pids.worker, "1");
    assert.equal(pids.ipc, false);
    const exited = once(guardian, "exit");
    assert.equal(guardian.kill(signal), true);
    assert.equal(guardian.killed, true);
    await exited;
    await until(
      async () => !(await alive(pids.backend)) && !(await alive(pids.tool)),
    );
    assert.equal(guardian.signalCode, "SIGKILL");
    assert.equal(guardian.kill(signal), false);
  });
}

test("parent death cleans only owned work", posix, async (t) => {
  const f = await fixture(t);
  const ownerFile = join(f.dir, "owner.mjs");
  const guardianPidFile = join(f.dir, "guardian.pid");
  await writeFile(
    ownerFile,
    `import { spawnCodexGuardian } from ${JSON.stringify(helper)};
import { writeFileSync } from "node:fs";
const guardian = spawnCodexGuardian(process.execPath, [${JSON.stringify(f.backend)}], ${JSON.stringify(f.dir)});
guardian.stderr.resume();
writeFileSync(${JSON.stringify(guardianPidFile)}, String(guardian.pid));
setInterval(() => {}, 1000);
`,
  );
  const owner = spawn(process.execPath, ["--import", "tsx", ownerFile], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  f.setOwner(owner);
  const pids = await f.ready();
  const guardianPid = Number(await readFile(guardianPidFile, "utf8"));
  const unrelated = spawn(
    process.execPath,
    ["-e", "setInterval(() => {}, 1000)"],
    { stdio: "ignore" },
  );
  t.after(() => unrelated.kill("SIGKILL"));
  assert.ok(unrelated.pid);
  const exited = once(owner, "exit");
  owner.kill("SIGKILL");
  await exited;
  await until(
    async () =>
      !(await alive(pids.backend)) &&
      !(await alive(pids.tool)) &&
      !(await alive(guardianPid)),
  );
  assert.equal(await alive(unrelated.pid), true);
});

test("backend exit cleans tools", posix, async (t) => {
  const f = await fixture(t, true);
  const guardian = spawnCodexGuardian(process.execPath, [f.backend], f.dir);
  f.setGuardian(guardian);
  const exited = once(guardian, "exit");
  const pids = await f.ready();
  await exited;
  await until(async () => !(await alive(pids.tool)));
});

test("IPC disconnect revokes ownership", posix, async (t) => {
  const f = await fixture(t);
  const guardian = spawnCodexGuardian(process.execPath, [f.backend], f.dir);
  f.setGuardian(guardian);
  const pids = await f.ready();
  const exited = once(guardian, "exit");
  guardian.disconnect();
  await exited;
  await until(
    async () => !(await alive(pids.backend)) && !(await alive(pids.tool)),
  );
});

test("disconnect during startup", posix, async (t) => {
  const f = await fixture(t);
  const guardian = spawnCodexGuardian(process.execPath, [f.backend], f.dir);
  f.setGuardian(guardian);
  const exited = once(guardian, "exit");
  guardian.disconnect();
  await exited;
  // The queued start may arrive before disconnect, but must be revoked either
  // way. Any backend PID that made it to readiness must already be dead.
  try {
    const pids = JSON.parse(
      await readFile(join(f.dir, "ready.json"), "utf8"),
    ) as Pids;
    await until(
      async () => !(await alive(pids.backend)) && !(await alive(pids.tool)),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
});

test("spawn failure hides secrets", posix, async (t) => {
  const f = await fixture(t);
  const guardian = spawnCodexGuardian(
    join(f.dir, "missing-secret-cli"),
    ["secret-token"],
    f.dir,
  );
  f.setGuardian(guardian);
  let stderr = "";
  guardian.stderr?.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  await once(guardian, "exit");
  assert.match(stderr, /could not start app-server/);
  assert.doesNotMatch(stderr, /missing-secret-cli|secret-token/);
});

test("entry point requires IPC", posix, async () => {
  const child = spawn(process.execPath, [fileURLToPath(entry)], {
    stdio: "ignore",
  });
  const [code] = await once(child, "exit");
  assert.equal(code, 1);
});
