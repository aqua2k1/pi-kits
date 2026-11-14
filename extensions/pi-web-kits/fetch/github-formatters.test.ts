import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { test } from "node:test";
import { resolveFetchConfig } from "../config.ts";
import { WebFetchError } from "./errors.ts";
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
    { name: "README.md" },
    { path: "README.txt", name: "README.md" },
  ]) {
    const text = "-   item\n";
    const endpoints: string[] = [];
    const command: CommandRunner = {
      async run(name, args) {
        assert.equal(name, "gh");
        assert.equal(args[0], "api");
        const endpoint = String(args.at(-1));
        endpoints.push(endpoint);
        if (endpoint === "repos/acme/project")
          return success('{"default_branch":"main"}');
        assert.equal(endpoint, "repos/acme/project/readme?ref=main");
        return success(
          JSON.stringify({
            ...metadata,
            encoding: "base64",
            content: Buffer.from(text).toString("base64"),
          }),
        );
      },
    };
    const handler = new GitHubHandler({
      config: resolveFetchConfig({ github: { enabled: true } }).github,
      apiTimeoutMs: 5_000,
      runtime: { command },
    });
    const response = await handler.fetch({
      url: new URL("https://github.com/acme/project"),
    });
    assert.ok(response);
    try {
      const filename = "path" in metadata ? metadata.path : metadata.name;
      const expected = filename === "README.md" ? "- item\n" : text;
      assert.ok(
        response.text.includes(`## ${filename ?? "README"}\n${expected}`),
      );
      assert.equal(
        await readFile(response.fullOutputPath, "utf8"),
        response.text,
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
  }
});

test("GitHub API formats base64 source blobs before storage", async () => {
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
    async run(name, args) {
      assert.equal(name, "gh");
      assert.equal(args[0], "api");
      const endpoint = String(args.at(-1));
      const path = endpoint.split("/contents/")[1]?.split("?")[0];
      const text = sources.get(path);
      assert.ok(text !== undefined);
      assert.equal(endpoint, `repos/acme/project/contents/${path}?ref=main`);
      return success(
        JSON.stringify({
          type: "file",
          encoding: "base64",
          content: Buffer.from(text).toString("base64"),
        }),
      );
    },
  };
  const handler = new GitHubHandler({
    config: resolveFetchConfig({ github: { enabled: true } }).github,
    apiTimeoutMs: 5_000,
    runtime: { command },
  });
  for (const [path, formatted] of expected) {
    const response = await handler.fetch({
      url: new URL(`https://github.com/acme/project/blob/main/${path}`),
    });
    assert.ok(response);
    try {
      const saved = await readFile(response.fullOutputPath, "utf8");
      assert.equal(saved, response.text);
      assert.equal(saved, formatted);
      assert.equal(response.source, "github-gh");
      assert.equal("repositoryPath" in response, false);
    } finally {
      await rm(dirname(response.fullOutputPath), {
        recursive: true,
        force: true,
      });
    }
  }
});

for (const kind of ["blob", "root"] as const) {
  test(`GitHub ${kind} cancellation during formatting cannot return saved content`, async () => {
    const controller = new AbortController();
    const command: CommandRunner = {
      async run(_name, args) {
        assert.equal(args[0], "api");
        const endpoint = String(args.at(-1));
        if (endpoint === "repos/acme/project")
          return success('{"default_branch":"main"}');
        assert.equal(
          endpoint,
          kind === "blob"
            ? "repos/acme/project/contents/README.md?ref=main"
            : "repos/acme/project/readme?ref=main",
        );
        // Queue cancellation after API decoding, while the formatter is pending.
        setImmediate(() => controller.abort());
        return success(
          JSON.stringify({
            type: "file",
            path: "README.md",
            encoding: "base64",
            content: Buffer.from("# Heading\n\n-   item\n").toString("base64"),
          }),
        );
      },
    };
    const handler = new GitHubHandler({
      config: { enabled: true },
      apiTimeoutMs: 5_000,
      runtime: { command },
    });
    await assert.rejects(
      handler.fetch(
        {
          url: new URL(
            kind === "blob"
              ? "https://github.com/acme/project/blob/main/README.md"
              : "https://github.com/acme/project",
          ),
        },
        controller.signal,
      ),
      (error: unknown) =>
        error instanceof WebFetchError && error.code === "cancelled",
    );
  });
}
