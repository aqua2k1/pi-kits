import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

type Event = { kind: string; id: string; args: string[] };
const script = fileURLToPath(
  new URL("scripts/macos-notify.sh", import.meta.url),
);

async function until(check: () => boolean) {
  const deadline = Date.now() + 5_000;
  while (!check()) {
    assert.ok(Date.now() < deadline, "Timed out waiting for adapter behavior");
    await delay(10);
  }
}

function harness() {
  const root = mkdtempSync(join(tmpdir(), "pi-macos-notify-"));
  const bin = join(root, "bin");
  const home = join(root, "home");
  const state = join(home, ".pi-kits-notifications");
  mkdirSync(bin);
  mkdirSync(home);
  const common = `
const fs = require("node:fs");
const path = require("node:path");
const root = process.env.TEST_ROOT;
const id = process.env.TEST_ID;
const args = process.argv.slice(2);
function event(kind) {
  fs.appendFileSync(path.join(root, "events"), JSON.stringify({kind, id, args}) + "\\n");
}
function wait(name) {
  const deadline = Date.now() + 10000;
  while (!fs.existsSync(path.join(root, name))) {
    if (Date.now() > deadline) process.exit(99);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
}
`;
  function executable(name: string, body: string) {
    const path = join(bin, name);
    writeFileSync(path, `#!${process.execPath}\n${common}\n${body}`);
    chmodSync(path, 0o700);
  }
  executable(
    "terminal-notifier",
    `const remove = args[0] === "-remove";
event(remove ? "remove-start" : "send-start");
if (process.env.NOTIFIER_GATE) wait(process.env.NOTIFIER_GATE);
if (process.env.NOTIFIER_FAIL || (remove && process.env.REMOVE_FAIL)) process.exit(23);
event(remove ? "remove-end" : "send-end");`,
  );
  executable(
    "sleep",
    `if (args[0] === "60") {
  event("timer");
  if (process.env.SLEEP_FAIL) process.exit(24);
  wait("timer-" + id);
} else {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
}`,
  );
  function events(): Event[] {
    if (!existsSync(join(root, "events"))) return [];
    return readFileSync(join(root, "events"), "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }
  const jobs: Promise<{ code: number; stderr: string }>[] = [];
  function send(id: string, env: Record<string, string> = {}) {
    const job = new Promise<{ code: number; stderr: string }>((resolve) => {
      execFile(
        "/bin/sh",
        [script, `Title ${id}`, "Message $; ' with spaces"],
        {
          env: {
            ...process.env,
            HOME: home,
            PATH: `${bin}:/usr/bin:/bin`,
            TEST_ROOT: root,
            TEST_ID: id,
            ...env,
          },
          timeout: 5_000,
        },
        (error, _stdout, stderr) => {
          resolve({ code: error ? Number(error.code) || 1 : 0, stderr });
        },
      );
    });
    jobs.push(job);
    return job;
  }
  function open(name: string) {
    writeFileSync(join(root, name), "");
  }
  async function waitEvent(kind: string, id: string) {
    await until(() => events().some((e) => e.kind === kind && e.id === id));
  }
  async function dispose() {
    for (const id of ["a", "b", "c"]) open(`timer-${id}`);
    open("send-gate");
    open("remove-gate");
    await Promise.all(jobs);
    await until(
      () =>
        !existsSync(state) ||
        !readdirSync(state).some((name) => name.startsWith("generation.")),
    );
    rmSync(root, { recursive: true, force: true });
  }
  return { bin, state, send, open, events, waitEvent, dispose };
}

const unix = { skip: process.platform === "win32" };

test("macOS: only latest timer removes the fixed group", unix, async (t) => {
  const h = harness();
  t.after(() => h.dispose());
  assert.equal((await h.send("a")).code, 0);
  await h.waitEvent("timer", "a");
  const old = readFileSync(join(h.state, "current"), "utf8");
  assert.equal((await h.send("b")).code, 0);
  await h.waitEvent("timer", "b");
  assert.notEqual(readFileSync(join(h.state, "current"), "utf8"), old);
  assert.equal(statSync(h.state).mode & 0o777, 0o700);
  assert.equal(statSync(join(h.state, "current")).mode & 0o777, 0o600);
  h.open("timer-a");
  await until(() => !existsSync(old.trim()));
  assert.equal(h.events().filter((e) => e.kind === "remove-start").length, 0);
  h.open("timer-b");
  await until(() => !existsSync(join(h.state, "current")));
  const sends = h.events().filter((e) => e.kind === "send-end");
  assert.deepEqual(sends[1].args, [
    "-title",
    "Title b",
    "-message",
    "Message $; ' with spaces",
    "-group",
    "pi-notification",
  ]);
  assert.deepEqual(
    h
      .events()
      .filter((e) => e.kind === "remove-end")
      .map((e) => e.args),
    [["-remove", "pi-notification"]],
  );
});

test("macOS: sending and recording exclude an old cleanup", unix, async (t) => {
  const h = harness();
  t.after(() => h.dispose());
  assert.equal((await h.send("a")).code, 0);
  await h.waitEvent("timer", "a");
  const old = readFileSync(join(h.state, "current"), "utf8").trim();
  const replacement = h.send("b", { NOTIFIER_GATE: "send-gate" });
  await h.waitEvent("send-start", "b");
  h.open("timer-a");
  await delay(100);
  assert.equal(
    h.events().some((e) => e.kind === "remove-start"),
    false,
  );
  h.open("send-gate");
  assert.equal((await replacement).code, 0);
  await until(() => !existsSync(old));
  assert.equal(
    h.events().some((e) => e.kind === "remove-start"),
    false,
  );
});

test("macOS: comparison and removal exclude a new send", unix, async (t) => {
  const h = harness();
  t.after(() => h.dispose());
  // This gate is initially open for delivery, then closed for removal.
  h.open("remove-gate");
  assert.equal((await h.send("a", { NOTIFIER_GATE: "remove-gate" })).code, 0);
  await h.waitEvent("timer", "a");
  rmSync(join(h.bin, "..", "remove-gate"));
  h.open("timer-a");
  await h.waitEvent("remove-start", "a");
  const replacement = h.send("b");
  await delay(100);
  assert.equal(
    h.events().some((e) => e.kind === "send-start" && e.id === "b"),
    false,
  );
  h.open("remove-gate");
  assert.equal((await replacement).code, 0);
  const events = h.events();
  assert.ok(
    events.findIndex((e) => e.kind === "remove-end") <
      events.findIndex((e) => e.kind === "send-start" && e.id === "b"),
  );
});

test("macOS: failed send preserves previous timer", unix, async (t) => {
  const h = harness();
  t.after(() => h.dispose());
  assert.equal((await h.send("a")).code, 0);
  await h.waitEvent("timer", "a");
  const old = readFileSync(join(h.state, "current"), "utf8");
  assert.equal((await h.send("b", { NOTIFIER_FAIL: "1" })).code, 23);
  assert.equal(readFileSync(join(h.state, "current"), "utf8"), old);
  assert.equal(existsSync(join(h.state, "lock")), false);
  assert.equal(
    h.events().some((e) => e.kind === "timer" && e.id === "b"),
    false,
  );
  h.open("timer-a");
  await until(() => !existsSync(join(h.state, "current")));
});

test("macOS: failed sleep does not delete", unix, async (t) => {
  const h = harness();
  t.after(() => h.dispose());
  assert.equal((await h.send("a", { SLEEP_FAIL: "1" })).code, 0);
  await until(
    () => !readdirSync(h.state).some((n) => n.startsWith("generation.")),
  );
  assert.equal(
    h.events().some((e) => e.kind === "remove-start"),
    false,
  );
  assert.equal((await h.send("b")).code, 0);
});

test("macOS: failed remove releases lock", unix, async (t) => {
  const h = harness();
  t.after(() => h.dispose());
  assert.equal((await h.send("a", { REMOVE_FAIL: "1" })).code, 0);
  await h.waitEvent("timer", "a");
  const generation = readFileSync(join(h.state, "current"), "utf8").trim();
  h.open("timer-a");
  await until(() => !existsSync(generation));
  assert.ok(existsSync(join(h.state, "current")));
  assert.equal(existsSync(join(h.state, "lock")), false);
  assert.equal((await h.send("b")).code, 0);
});

test("macOS: failed recording prevents delivery", unix, async (t) => {
  const h = harness();
  t.after(() => h.dispose());
  assert.equal((await h.send("a")).code, 0);
  await h.waitEvent("timer", "a");
  const old = readFileSync(join(h.state, "current"), "utf8");
  writeFileSync(join(h.bin, "mv"), "#!/bin/sh\nexit 25\n", { mode: 0o700 });
  assert.equal((await h.send("b")).code, 25);
  assert.equal(readFileSync(join(h.state, "current"), "utf8"), old);
  assert.equal(existsSync(join(h.state, "lock")), false);
  assert.equal(
    h.events().some((e) => e.kind === "send-start" && e.id === "b"),
    false,
  );
  h.open("timer-a");
  await until(() => !existsSync(join(h.state, "current")));
});

test("macOS: missing notifier exits without state", unix, async (t) => {
  const h = harness();
  t.after(() => h.dispose());
  rmSync(join(h.bin, "terminal-notifier"));
  assert.equal((await h.send("a", { PATH: h.bin })).code, 127);
  assert.equal(existsSync(h.state), false);
});

test("macOS: abandoned lock fails closed", unix, async (t) => {
  const h = harness();
  t.after(() => h.dispose());
  mkdirSync(h.state, { mode: 0o700 });
  mkdirSync(join(h.state, "lock"));
  const result = await h.send("a");
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /Could not acquire notification lock/);
  assert.equal(h.events().length, 0);
  assert.ok(existsSync(join(h.state, "lock")));
});
