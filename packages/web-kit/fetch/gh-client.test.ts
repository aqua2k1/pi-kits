import assert from "node:assert/strict";
import { test } from "node:test";
import { GhClient } from "./gh-client.ts";
import type { CommandResult, CommandRunner } from "./types.ts";

function result(overrides: Partial<CommandResult> = {}): CommandResult {
  return {
    code: 0,
    signal: null,
    stdout: "",
    stderr: "",
    notFound: false,
    timedOut: false,
    aborted: false,
    stdoutTruncated: false,
    stderrTruncated: false,
    ...overrides,
  };
}

test("GhClient parses metadata through fixed gh api arguments", async () => {
  const calls: { command: string; args: readonly string[] }[] = [];
  const command: CommandRunner = {
    async run(commandName, args) {
      calls.push({ command: commandName, args });
      if (args[0] === "--version") return result({ stdout: "gh version 2\n" });
      return result({
        stdout: JSON.stringify({ default_branch: "main", size: 12_288 }),
      });
    },
  };
  const client = new GhClient({ command, timeoutMs: 5_000 });
  assert.deepEqual(await client.repoMetadata("acme", "project"), {
    defaultBranch: "main",
    sizeMB: 12,
  });
  assert.deepEqual(calls, [
    { command: "gh", args: ["--version"] },
    {
      command: "gh",
      args: ["api", "--hostname", "github.com", "repos/acme/project"],
    },
  ]);
});

test("GhClient returns null when gh is unavailable", async () => {
  const command: CommandRunner = {
    async run() {
      return result({ notFound: true, code: null });
    },
  };
  const client = new GhClient({ command, timeoutMs: 5_000 });
  assert.equal(await client.isGhAvailable(), false);
  assert.equal(await client.apiJson("repos/acme/project"), null);
});

test("GhClient uses gh repo clone before the public git fallback", async () => {
  const calls: { command: string; args: readonly string[] }[] = [];
  const command: CommandRunner = {
    async run(commandName, args) {
      calls.push({ command: commandName, args });
      if (commandName === "gh" && args[0] === "--version") {
        return result({ stdout: "gh version 2\n" });
      }
      return result();
    },
  };
  const client = new GhClient({ command, timeoutMs: 5_000 });
  assert.equal(
    await client.clone({
      owner: "acme",
      repo: "project",
      ref: "main",
      destination: "/tmp/clone",
      timeoutMs: 5_000,
    }),
    true,
  );
  assert.deepEqual(calls[1], {
    command: "gh",
    args: [
      "repo",
      "clone",
      "acme/project",
      "/tmp/clone",
      "--",
      "--depth",
      "1",
      "--single-branch",
      "--no-tags",
      "--branch",
      "main",
    ],
  });
});
