import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { TEMP_SPOOL_TTL_MS } from "../shared/limits.ts";
import { GitHubHandler } from "./github.ts";
import type { CommandResult, CommandRunner, FetchResponse } from "./types.ts";

function result(code = 0): CommandResult {
  return {
    code,
    signal: null,
    stdout: "",
    stderr: "",
    notFound: false,
    timedOut: false,
    aborted: false,
    stdoutTruncated: false,
    stderrTruncated: false,
  };
}

const request = {
  url: new URL("https://github.com/acme/project/blob/main/README.md"),
};

test("clone operations own unique directories across handlers, failures and retries", async () => {
  const base = await mkdtemp(join(tmpdir(), "pi-clone-isolation-test-"));
  const responses: FetchResponse[] = [];
  const destinations: string[] = [];
  let now = Date.now();
  function handler(content: string, fail = false): GitHubHandler {
    const command: CommandRunner = {
      async run(name, args) {
        if (args[0] === "--version") return result();
        if (name === "gh" && args[0] === "repo") {
          const destination = args[3];
          destinations.push(destination);
          await mkdir(destination, { recursive: true });
          await writeFile(join(destination, "README.md"), content);
          return result(fail ? 1 : 0);
        }
        return result(1);
      },
    };
    return new GitHubHandler({
      config: {
        enabled: true,
        mode: "clone",
        maxRepoSizeMB: 350,
        cloneTimeoutSeconds: 30,
        clonePath: base,
      },
      apiTimeoutMs: 1_000,
      runtime: { command, now: () => now },
    });
  }
  try {
    const firstHandler = handler("first");
    const [first, second] = await Promise.all([
      firstHandler.fetch(request),
      handler("second").fetch(request),
    ]);
    assert.ok(first?.repositoryPath);
    assert.ok(second?.repositoryPath);
    responses.push(first, second);
    assert.notEqual(first.repositoryPath, second.repositoryPath);
    assert.equal(
      await readFile(join(first.repositoryPath, "README.md"), "utf8"),
      "first",
    );
    assert.equal(
      await readFile(join(second.repositoryPath, "README.md"), "utf8"),
      "second",
    );

    const failing = handler("failed", true);
    assert.equal(await failing.fetch(request), null);
    assert.equal(await failing.fetch(request), null);
    assert.equal(new Set(destinations).size, 4);
    assert.equal((await readdir(base)).length, 2);
    assert.equal(
      await readFile(join(first.repositoryPath, "README.md"), "utf8"),
      "first",
    );

    now += TEMP_SPOOL_TTL_MS - 1_000;
    const reused = await firstHandler.fetch(request);
    assert.ok(reused);
    responses.push(reused);
    assert.equal(reused.repositoryPath, first.repositoryPath);
    assert.equal((await stat(dirname(first.repositoryPath))).mtimeMs, now);

    // The renewed clone survives cleanup after its original expiration.
    now += 2_000;
    const renewed = await firstHandler.fetch(request);
    assert.ok(renewed);
    responses.push(renewed);
    assert.equal(renewed.repositoryPath, first.repositoryPath);
    assert.equal(destinations.length, 4);
  } finally {
    for (const response of responses) {
      await rm(dirname(response.fullOutputPath), {
        recursive: true,
        force: true,
      });
    }
    await rm(base, { recursive: true, force: true });
  }
});
