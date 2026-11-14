import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { test } from "node:test";
import { MAX_FETCH_CONTENT_BYTES } from "../shared/limits.ts";
import { WebFetchError } from "./errors.ts";
import { buildFetchOutput } from "./format.ts";
import { GitHubHandler } from "./github.ts";
import type { CommandResult, CommandRunner } from "./types.ts";

function result(stdout = ""): CommandResult {
  return {
    code: 0,
    signal: null,
    stdout,
    stderr: "",
    notFound: false,
    timedOut: false,
    aborted: false,
    stdoutTruncated: false,
    stderrTruncated: false,
  };
}

function readmeHandler(readme: string, stdoutTruncated = false) {
  const endpoints: string[] = [];
  const command: CommandRunner = {
    async run(name, args) {
      assert.equal(name, "gh");
      assert.equal(args[0], "api");
      const endpoint = String(args.at(-1));
      endpoints.push(endpoint);
      if (endpoint === "repos/acme/project") {
        return result(JSON.stringify({ default_branch: "main" }));
      }
      assert.equal(endpoint, "repos/acme/project/readme?ref=main");
      return {
        ...result(
          JSON.stringify({
            path: "README.txt",
            encoding: "base64",
            content: Buffer.from(readme).toString("base64"),
          }),
        ),
        stdoutTruncated,
      };
    },
  };
  return {
    handler: new GitHubHandler({
      config: { enabled: true },
      apiTimeoutMs: 1_000,
      runtime: { command },
    }),
    endpoints,
  };
}

const request = { url: new URL("https://github.com/acme/project") };

test("API root README is not independently limited to 8 KiB and never requests a tree", async () => {
  const readme = `${"README body\n".repeat(1_000)}END-OF-README`;
  const { handler, endpoints } = readmeHandler(readme);
  const response = await handler.fetch(request);
  assert.ok(response);
  try {
    const saved = await readFile(response.fullOutputPath, "utf8");
    assert.ok(saved.includes(readme));
    assert.equal(saved, response.text);
    assert.equal(
      buildFetchOutput(response).details.savedContent.truncated,
      false,
    );
    assert.deepEqual(endpoints, [
      "repos/acme/project",
      "repos/acme/project/readme?ref=main",
    ]);
  } finally {
    await rm(dirname(response.fullOutputPath), {
      recursive: true,
      force: true,
    });
  }
});

test("API root README uses the overall saved-content limit and reports truncation", async () => {
  // The injected runner bypasses the smaller command-output budget to isolate
  // the saved-content boundary. Real oversized API responses are rejected below.
  const readme = `${"x".repeat(MAX_FETCH_CONTENT_BYTES)}OMITTED-END-MARKER`;
  const { handler } = readmeHandler(readme);
  const response = await handler.fetch(request);
  assert.ok(response);
  try {
    const output = buildFetchOutput(response);
    assert.equal(output.details.savedContent.truncated, true);
    assert.equal(output.details.savedContent.bytes, MAX_FETCH_CONTENT_BYTES);
    assert.ok(output.details.savedContent.truncation);
    assert.ok(
      output.details.savedContent.truncation.totalBytes >
        Buffer.byteLength(readme),
      "logical source size includes the complete README and repository wrapper",
    );
    assert.equal(
      output.details.savedContent.truncation.totalBytes,
      response.contentLength,
    );
    assert.match(
      output.content[0].text,
      /cannot recover omitted source content/,
    );
    assert.ok(!response.text.includes("OMITTED-END-MARKER"));
    assert.equal(
      await readFile(response.fullOutputPath, "utf8"),
      response.text,
    );
  } finally {
    await rm(dirname(response.fullOutputPath), {
      recursive: true,
      force: true,
    });
  }
});

test("API root README rejects truncated command output rather than saving incomplete base64", async () => {
  const { handler } = readmeHandler("README body", true);
  await assert.rejects(
    handler.fetch(request),
    (error: unknown) =>
      error instanceof WebFetchError && error.code === "invalid-response",
  );
});
