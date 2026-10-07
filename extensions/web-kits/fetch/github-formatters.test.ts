import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { resolveFetchConfig } from "../config.ts";
import { GitHubHandler } from "./github.ts";
import type { CommandResult, CommandRunner } from "./types.ts";

const success = (stdout = ""): CommandResult => ({
  code: 0,
  signal: null,
  stdout,
  stderr: "",
  notFound: false,
  timedOut: false,
  aborted: false,
  stdoutTruncated: false,
  stderrTruncated: false,
});

test("GitHub API README uses its returned filename and preserves unknown/plain formats", async () => {
  for (const metadata of [
    { path: "docs/README.txt" },
    { name: "README.rst" },
    {},
    { path: "README.md" },
  ]) {
    const text = "-   item\n";
    const command: CommandRunner = {
      async run(_name, args) {
        if (args[0] === "--version") return success("gh version 2");
        const endpoint = String(args.at(-1));
        if (endpoint === "repos/acme/project")
          return success('{"default_branch":"main"}');
        if (endpoint.includes("/git/trees/")) return success('{"tree":[]}');
        assert.ok(endpoint.includes("/readme?"));
        return success(
          JSON.stringify({
            ...metadata,
            content: Buffer.from(text).toString("base64"),
          }),
        );
      },
    };
    const handler = new GitHubHandler({
      config: resolveFetchConfig({ github: { mode: "api" } }).github,
      apiTimeoutMs: 5_000,
      runtime: { command },
    });
    const response = await handler.fetch({
      url: new URL("https://github.com/acme/project"),
    });
    assert.ok(response);
    try {
      const expected =
        "path" in metadata && metadata.path === "README.md" ? "- item\n" : text;
      assert.ok(response.text.includes(`## README.md\n${expected}`));
    } finally {
      await rm(dirname(response.fullOutputPath), {
        recursive: true,
        force: true,
      });
    }
  }
});

for (const mode of ["api", "clone"] as const) {
  test(`GitHub ${mode} formats source blobs before storage or scaffold rendering`, async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-github-format-"));
    const sources = new Map([
      ["data.json", '{"large":900719925474099312345,"x":[1,2]}'],
      ["page.html", "<title>Docs</title><p>Hello</p>"],
      ["README.md", "# Heading\n\n-   item\n"],
      ["broken.json", '{"broken":'],
      ["data.xml", "<root>  unchanged </root>"],
    ]);
    const expected = new Map([
      ["data.json", '{ "large": 900719925474099312345, "x": [1, 2] }\n'],
      ["page.html", "<title>Docs</title>\n<p>Hello</p>\n"],
      ["README.md", "# Heading\n\n- item\n"],
      ["broken.json", '{"broken":'],
      ["data.xml", "<root>  unchanged </root>"],
    ]);
    const command: CommandRunner = {
      async run(_name, args) {
        if (args[0] === "--version") return success("gh version 2");
        if (args[0] === "repo") {
          await mkdir(args[3], { recursive: true });
          for (const [path, text] of sources)
            await writeFile(join(args[3], path), text);
          return success();
        }
        assert.equal(args[0], "api");
        const path = String(args.at(-1)).split("/contents/")[1]?.split("?")[0];
        const text = sources.get(path);
        assert.ok(text !== undefined);
        return success(
          JSON.stringify({
            type: "file",
            content: Buffer.from(text).toString("base64"),
          }),
        );
      },
    };
    const handler = new GitHubHandler({
      config: resolveFetchConfig({ github: { mode, clonePath: root } }).github,
      apiTimeoutMs: 5_000,
      runtime: { command },
    });
    try {
      for (const [path, formatted] of expected) {
        const response = await handler.fetch({
          url: new URL(`https://github.com/acme/project/blob/main/${path}`),
        });
        assert.ok(response);
        try {
          const saved = await readFile(response.fullOutputPath, "utf8");
          assert.equal(saved, response.text);
          if (mode === "api") assert.equal(saved, formatted);
          else {
            assert.ok(saved.includes(`## ${path}\n${formatted}`));
            assert.match(saved, /Repository cloned to:/);
            // Formatting only touches the saved view, not cloned source files.
            assert.equal(
              await readFile(join(response.repositoryPath ?? "", path), "utf8"),
              sources.get(path),
            );
          }
        } finally {
          await rm(dirname(response.fullOutputPath), {
            recursive: true,
            force: true,
          });
        }
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
