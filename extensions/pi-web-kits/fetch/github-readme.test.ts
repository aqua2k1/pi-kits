import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MAX_FETCH_CONTENT_BYTES } from "../shared/limits.ts";
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

for (const mode of ["api", "clone"] as const) {
  test(`${mode} root README is not independently limited to 8 KiB`, async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-web-readme-"));
    const readme = `${"README body\n".repeat(1_000)}END-OF-README`;
    const command: CommandRunner = {
      async run(_name, args) {
        if (args[0] === "--version") return result("gh version 2");
        if (args[0] === "repo") {
          const destination = args[3];
          await mkdir(destination, { recursive: true });
          await writeFile(join(destination, "README.txt"), readme);
          return result();
        }
        const endpoint = args.at(-1) ?? "";
        if (endpoint === "repos/acme/project") {
          return result(JSON.stringify({ default_branch: "main", size: 1 }));
        }
        if (endpoint.includes("/git/trees/")) {
          return result(JSON.stringify({ tree: [] }));
        }
        if (endpoint.includes("/readme?")) {
          return result(
            JSON.stringify({
              path: "README.txt",
              content: Buffer.from(readme).toString("base64"),
            }),
          );
        }
        return { ...result(), code: 1 };
      },
    };
    const handler = new GitHubHandler({
      config: {
        enabled: true,
        mode,
        maxRepoSizeMB: 350,
        cloneTimeoutSeconds: 30,
        clonePath: root,
      },
      apiTimeoutMs: 1_000,
      runtime: { command },
    });
    let savedPath: string | undefined;
    try {
      const response = await handler.fetch({
        url: new URL("https://github.com/acme/project"),
      });
      assert.ok(response);
      savedPath = response.fullOutputPath;
      const saved = await readFile(savedPath, "utf8");
      assert.ok(saved.includes(readme));
      assert.equal(
        buildFetchOutput(response).details.savedContent.truncated,
        false,
      );
    } finally {
      if (savedPath)
        await rm(join(savedPath, ".."), { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("clone root README uses the overall saved-content limit and reports truncation", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-readme-limit-"));
  const command: CommandRunner = {
    async run(_name, args) {
      if (args[0] === "--version") return result("gh version 2");
      if (args[0] === "repo") {
        const destination = args[3];
        await mkdir(destination, { recursive: true });
        const file = await open(join(destination, "README.txt"), "w");
        try {
          const chunk = Buffer.alloc(1_024 * 1_024, "x");
          for (let i = 0; i < MAX_FETCH_CONTENT_BYTES / chunk.length; i++) {
            await file.write(chunk);
          }
          for (let i = 0; i < MAX_FETCH_CONTENT_BYTES / chunk.length; i++) {
            await file.write(chunk);
          }
          await file.write("OMITTED-END-MARKER");
        } finally {
          await file.close();
        }
        return result();
      }
      return { ...result(), code: 1 };
    },
  };
  const handler = new GitHubHandler({
    config: {
      enabled: true,
      mode: "clone",
      maxRepoSizeMB: 350,
      cloneTimeoutSeconds: 30,
      clonePath: root,
    },
    apiTimeoutMs: 1_000,
    runtime: { command },
  });
  let savedPath: string | undefined;
  try {
    const response = await handler.fetch({
      url: new URL("https://github.com/acme/project"),
    });
    assert.ok(response);
    savedPath = response.fullOutputPath;
    const output = buildFetchOutput(response);
    assert.equal(output.details.savedContent.truncated, true);
    assert.equal(output.details.savedContent.bytes, MAX_FETCH_CONTENT_BYTES);
    assert.ok(output.details.savedContent.truncation);
    const originalReadmeBytes =
      2 * MAX_FETCH_CONTENT_BYTES + Buffer.byteLength("OMITTED-END-MARKER");
    assert.ok(
      output.details.savedContent.truncation.totalBytes > originalReadmeBytes,
      "logical source size must include the complete README and repository wrapper",
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
  } finally {
    if (savedPath)
      await rm(join(savedPath, ".."), { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});
