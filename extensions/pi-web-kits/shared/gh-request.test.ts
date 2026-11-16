import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter, getEventListeners } from "node:events";
import { type TestContext, test } from "node:test";
import { GhRequestError, ghRequest } from "./gh-request.ts";
import { MAX_GITHUB_COMMAND_OUTPUT_BYTES } from "./limits.ts";

const endpoint = "repos/acme/project";

function childFixture(pid?: number) {
  const signals: NodeJS.Signals[] = [];
  const child = Object.assign(new EventEmitter(), {
    pid,
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    kill(signal: NodeJS.Signals) {
      signals.push(signal);
      return true;
    },
  });
  const spawnChild = (() => child as unknown as ChildProcess) as typeof spawn;
  return { child, signals, spawnChild };
}

function response(stdout: string, stderr = "", code = 0) {
  const { child, spawnChild } = childFixture();
  return ((...args: Parameters<typeof spawn>) => {
    queueMicrotask(() => {
      child.stdout.emit("data", Buffer.from(stdout));
      child.stderr.emit("data", Buffer.from(stderr));
      child.emit("close", code, null);
    });
    return spawnChild(...args);
  }) as typeof spawn;
}

test("ghRequest fixes read-only arguments, host, environment and shell settings", async () => {
  const value = {
    default_branch: "main",
    description: "A project",
    size: 12_288,
  };
  const spawnResponse = response(JSON.stringify(value));
  const injected = ((...args: Parameters<typeof spawn>) => {
    assert.equal(args[0], "gh");
    assert.deepEqual(args[1], [
      "api",
      "--method",
      "GET",
      "--hostname",
      "github.com",
      endpoint,
    ]);
    const options = args[2];
    assert.equal(options?.env?.GH_PROMPT_DISABLED, "1");
    assert.equal(options?.shell, false);
    assert.equal(options?.detached, process.platform !== "win32");
    assert.deepEqual(options?.stdio, ["ignore", "pipe", "pipe"]);
    return spawnResponse(...args);
  }) as typeof spawn;
  assert.deepEqual(
    await ghRequest(endpoint, { timeoutMs: 5000, spawn: injected }),
    value,
  );
  // JSON values are returned directly, without an envelope or business validation.
  for (const value of [null, [], false, 1, "text"]) {
    assert.deepEqual(
      await ghRequest(endpoint, {
        timeoutMs: 5000,
        spawn: response(JSON.stringify(value)),
      }),
      value,
    );
  }
});

test("ghRequest permits only the fixed JSON text-match Accept header", async () => {
  const spawnResponse = response("{}");
  const injected = ((...args: Parameters<typeof spawn>) => {
    assert.deepEqual(args[1], [
      "api",
      "--method",
      "GET",
      "--hostname",
      "github.com",
      "--header",
      "Accept: application/vnd.github.text-match+json",
      endpoint,
    ]);
    return spawnResponse(...args);
  }) as typeof spawn;
  assert.deepEqual(
    await ghRequest(endpoint, {
      timeoutMs: 5000,
      accept: "application/vnd.github.text-match+json",
      spawn: injected,
    }),
    {},
  );
  for (const accept of [
    "text/html",
    "application/json\r\nAuthorization: secret",
    "",
  ]) {
    await assert.rejects(
      ghRequest(endpoint, {
        timeoutMs: 5000,
        accept: accept as "application/vnd.github.text-match+json",
        spawn: (() => assert.fail("must not spawn")) as typeof spawn,
      }),
      { code: "request" },
    );
  }
});

for (const invalid of [
  "https://evil.example/repos/acme/project",
  "http://github.com/user",
  "//evil.example/user",
  "/user",
  "--hostname=evil.example",
  "-XPOST",
  "user\n--method POST",
  "user\\path",
  "",
  "user#fragment",
]) {
  test(`ghRequest rejects unsafe endpoint ${JSON.stringify(invalid)} before spawning`, async () => {
    await assert.rejects(
      ghRequest(invalid, {
        timeoutMs: 5000,
        spawn: (() => assert.fail("must not spawn")) as typeof spawn,
      }),
      { code: "request" },
    );
  });
}

for (const [stderr, exitCode, code, status] of [
  ["", 4, "auth", undefined],
  ["gh auth login secret", 1, "auth", undefined],
  ["GH_TOKEN secret", 1, "auth", undefined],
  ["authentication secret", 1, "auth", undefined],
  ["forbidden (HTTP 403) secret", 1, "status", 403],
  ["API rate limit exceeded (HTTP 403) secret", 1, "rate-limit", 403],
  ["too many requests (HTTP 429) secret", 1, "rate-limit", 429],
  ["Not Found (HTTP 404) secret", 1, "status", 404],
  ["error (HTTP 500) secret", 1, "status", 500],
  ["secret", 1, "request", undefined],
] as const) {
  test(`ghRequest sanitizes ${code}/${status ?? exitCode}`, async () => {
    await assert.rejects(
      ghRequest(endpoint, {
        timeoutMs: 5000,
        spawn: response("", stderr, exitCode),
      }),
      (error: unknown) => {
        assert.ok(error instanceof GhRequestError);
        assert.equal(error.code, code);
        assert.equal(error.status, status);
        assert.ok(!error.message.includes("secret"));
        return true;
      },
    );
  });
}

test("ghRequest rejects invalid JSON and bounds stdout and stderr", async () => {
  await assert.rejects(
    ghRequest(endpoint, { timeoutMs: 5000, spawn: response("not json") }),
    { code: "invalid-response" },
  );
  const { child, signals, spawnChild } = childFixture();
  const promise = ghRequest(endpoint, { timeoutMs: 5000, spawn: spawnChild });
  child.stderr.emit("data", Buffer.from("x".repeat(16 * 1024)));
  child.stderr.emit("data", Buffer.from("HTTP 403")); // Outside the retained diagnostic budget.
  child.stdout.emit(
    "data",
    Buffer.from("x".repeat(MAX_GITHUB_COMMAND_OUTPUT_BYTES)),
  );
  assert.deepEqual(signals, []);
  child.stdout.emit("data", Buffer.from("overflow"));
  assert.deepEqual(signals, ["SIGTERM"]);
  child.emit("close", 0, "SIGTERM");
  await assert.rejects(promise, { code: "invalid-response" });
  await assert.rejects(
    ghRequest(endpoint, {
      timeoutMs: 5000,
      spawn: response("", `${"x".repeat(16 * 1024)} HTTP 403`, 1),
    }),
    { code: "request" },
  );
});

test("ghRequest accepts URI-encoded paths including encodeURIComponent punctuation", async () => {
  const path = encodeURIComponent("a file!'()*.txt");
  assert.deepEqual(
    await ghRequest(`repos/acme/project/contents/${path}?ref=feature%2Ftopic`, {
      timeoutMs: 5000,
      spawn: response("{}"),
    }),
    {},
  );
});

test("ghRequest sanitizes synchronous spawn and asynchronous process errors", async () => {
  for (const code of ["ENOENT", "EACCES"]) {
    await assert.rejects(
      ghRequest(endpoint, {
        timeoutMs: 5000,
        spawn: (() => {
          throw Object.assign(new Error("secret"), { code });
        }) as typeof spawn,
      }),
      { code: code === "ENOENT" ? "tool-unavailable" : "network" },
    );
    const { child, spawnChild } = childFixture();
    const promise = ghRequest(endpoint, { timeoutMs: 5000, spawn: spawnChild });
    child.emit("error", Object.assign(new Error("secret"), { code }));
    await assert.rejects(promise, {
      code: code === "ENOENT" ? "tool-unavailable" : "network",
    });
  }
  await assert.rejects(
    ghRequest(endpoint, {
      timeoutMs: 5000,
      spawn: (() => {
        throw new Error("secret");
      }) as typeof spawn,
    }),
    { code: "network" },
  );
});

test("pre-cancellation prevents spawning", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    ghRequest(endpoint, {
      signal: controller.signal,
      timeoutMs: 5000,
      spawn: (() => assert.fail("must not spawn")) as typeof spawn,
    }),
    { code: "cancelled" },
  );
});

function shutdown(t: TestContext, pid?: number) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const fixture = childFixture(pid);
  const controller = new AbortController();
  const promise = ghRequest(endpoint, {
    signal: controller.signal,
    timeoutMs: 100,
    spawn: fixture.spawnChild,
  });
  return { ...fixture, controller, promise };
}

test("timeout then cancellation keeps the original TERM-to-KILL deadline", async (t) => {
  const { child, signals, controller, promise } = shutdown(t);
  t.mock.timers.tick(100);
  assert.deepEqual(signals, ["SIGTERM"]);
  t.mock.timers.tick(10);
  controller.abort();
  t.mock.timers.tick(240);
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
  child.emit("close", null, "SIGKILL");
  await assert.rejects(promise, { code: "cancelled" });
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("close before escalation removes timers and cancellation listeners", async (t) => {
  const { child, signals, controller, promise } = shutdown(t);
  const clear = t.mock.method(globalThis, "clearTimeout");
  t.mock.timers.tick(100);
  child.emit("close", null, "SIGTERM");
  await assert.rejects(promise, { code: "timeout" });
  assert.equal(clear.mock.callCount(), 2);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  controller.abort();
  t.mock.timers.tick(1000);
  assert.deepEqual(signals, ["SIGTERM"]);
});

test("cancellation alone escalates and remains distinct from timeout", async (t) => {
  const { child, signals, controller, promise } = shutdown(t);
  controller.abort();
  t.mock.timers.tick(250);
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
  child.emit("close", null, "SIGKILL");
  await assert.rejects(promise, { code: "cancelled" });
});

test("cancellation during spawn is observed after listener setup", async () => {
  const controller = new AbortController();
  const { child, signals, spawnChild } = childFixture();
  const promise = ghRequest(endpoint, {
    timeoutMs: 5000,
    signal: controller.signal,
    spawn: ((...args: Parameters<typeof spawn>) => {
      controller.abort();
      return spawnChild(...args);
    }) as typeof spawn,
  });
  assert.deepEqual(signals, ["SIGTERM"]);
  child.emit("close", null, "SIGTERM");
  await assert.rejects(promise, { code: "cancelled" });
});

for (const fails of [false, true]) {
  test(`process-group termination with child fallback=${fails}`, {
    skip: process.platform === "win32",
  }, async (t) => {
    const calls: [number, string | number | undefined][] = [];
    t.mock.method(process, "kill", (pid: number, signal?: string | number) => {
      calls.push([pid, signal]);
      if (fails) throw new Error("already exited");
      return true;
    });
    const { child, signals, promise } = shutdown(t, 12345);
    t.mock.timers.tick(100);
    t.mock.timers.tick(250);
    assert.deepEqual(calls, [
      [-12345, "SIGTERM"],
      [-12345, "SIGKILL"],
    ]);
    assert.deepEqual(signals, fails ? ["SIGTERM", "SIGKILL"] : []);
    child.emit("close", null, "SIGKILL");
    await assert.rejects(promise, { code: "timeout" });
  });
}

test("real spawned process output is bounded and real cancellation terminates it", async () => {
  const nodeSpawn = (script: string) =>
    ((..._args: Parameters<typeof spawn>) =>
      spawn(process.execPath, ["-e", script], {
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
      })) as typeof spawn;
  await assert.rejects(
    ghRequest(endpoint, {
      timeoutMs: 5000,
      spawn: nodeSpawn(
        `process.stdout.write('x'.repeat(${MAX_GITHUB_COMMAND_OUTPUT_BYTES + 1}))`,
      ),
    }),
    { code: "invalid-response" },
  );
  const controller = new AbortController();
  const promise = ghRequest(endpoint, {
    timeoutMs: 1000,
    signal: controller.signal,
    spawn: nodeSpawn("setTimeout(() => {}, 5000)"),
  });
  const timer = setTimeout(() => controller.abort(), 10);
  try {
    await assert.rejects(promise, { code: "cancelled" });
  } finally {
    clearTimeout(timer);
  }
});
