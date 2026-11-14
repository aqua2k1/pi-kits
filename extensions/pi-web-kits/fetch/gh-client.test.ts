import assert from "node:assert/strict";
import { test } from "node:test";
import { GhClient } from "./gh-client.ts";
import type { CommandResult, CommandRunner } from "./types.ts";

function result(overrides: Partial<CommandResult> = {}): CommandResult {
  return {
    code: 0,
    signal: null,
    stdout: "{}",
    stderr: "",
    notFound: false,
    timedOut: false,
    aborted: false,
    stdoutTruncated: false,
    stderrTruncated: false,
    ...overrides,
  };
}

test("GhClient uses only fixed public gh api arguments and bounded execution", async () => {
  const command: CommandRunner = {
    async run(name, args, options) {
      assert.equal(name, "gh");
      assert.deepEqual(args, [
        "api",
        "--hostname",
        "github.com",
        "repos/acme/project",
      ]);
      assert.equal(options.env?.GH_PROMPT_DISABLED, "1");
      assert.equal(options.timeoutMs, 5000);
      assert.ok(options.maxStdoutBytes > 0);
      return result({
        stdout: JSON.stringify({
          default_branch: "main",
          description: "A project",
          size: 12_288,
        }),
      });
    },
  };
  assert.deepEqual(
    await new GhClient({ command, timeoutMs: 5000 }).repoMetadata(
      "acme",
      "project",
    ),
    { defaultBranch: "main", description: "A project" },
  );
});

for (const [overrides, code] of [
  [{ notFound: true, code: null }, "tool-unavailable"],
  [{ timedOut: true }, "timeout"],
  [{ aborted: true }, "cancelled"],
  [{ stdoutTruncated: true }, "invalid-response"],
  [{ stdout: "not json" }, "invalid-response"],
  [{ code: 4 }, "auth"],
  [{ code: 1, stderr: "gh: forbidden (HTTP 403) secret" }, "auth"],
  [
    { code: 1, stderr: "gh: API rate limit exceeded (HTTP 403) secret" },
    "rate-limit",
  ],
  [
    { code: 1, stderr: "gh: too many requests (HTTP 429) secret" },
    "rate-limit",
  ],
  [{ code: 1, stderr: "gh: error (HTTP 500) secret" }, "network"],
  [{ code: 1, stderr: "secret" }, "request"],
] as const) {
  test(`GhClient classifies ${code} without exposing diagnostics: ${JSON.stringify(overrides)}`, async () => {
    const client = new GhClient({
      command: {
        async run() {
          return result(overrides);
        },
      },
      timeoutMs: 5000,
    });
    await assert.rejects(
      client.apiJson("repos/acme/project"),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal((error as { code?: string }).code, code);
        assert.ok(!error.message.includes("secret"));
        return true;
      },
    );
  });
}

test("GhClient permits a missing optional resource and rejects invalid metadata", async () => {
  const command = {
    async run() {
      return result({ code: 1, stderr: "gh: Not Found (HTTP 404)" });
    },
  };
  assert.equal(
    await new GhClient({ command, timeoutMs: 5000 }).apiJson(
      "repos/acme/project/readme",
    ),
    null,
  );
  await assert.rejects(
    new GhClient({
      command: {
        async run() {
          return result({ stdout: "[]" });
        },
      },
      timeoutMs: 5000,
    }).repoMetadata("acme", "project"),
    { code: "invalid-response" },
  );
});

test("GhClient cancellation prevents command execution", async () => {
  const controller = new AbortController();
  controller.abort();
  const client = new GhClient({
    command: {
      async run() {
        assert.fail("must not execute");
      },
    },
    timeoutMs: 5000,
  });
  await assert.rejects(
    client.apiJson("repos/acme/project", controller.signal),
    { code: "cancelled" },
  );
});
