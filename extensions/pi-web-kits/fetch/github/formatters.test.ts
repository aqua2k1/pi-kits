import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { test } from "node:test";
import { resolveFetchConfig } from "../../config.ts";
import type { ghRequest } from "../../shared/gh-request.ts";
import { WebFetchError } from "../errors.ts";
import { createGitHubFetchHandler } from "./handler.ts";

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
    const request: typeof ghRequest = async (endpoint) => {
      endpoints.push(endpoint);
      if (endpoint === "repos/acme/project") return { default_branch: "main" };
      assert.equal(endpoint, "repos/acme/project/readme?ref=main");
      return {
        ...metadata,
        encoding: "base64",
        content: Buffer.from(text).toString("base64"),
      };
    };
    const handler = createGitHubFetchHandler({
      config: resolveFetchConfig({ github: { enabled: true } }).github,
      apiTimeoutMs: 5_000,
      runtime: { ghRequest: request },
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
  const request: typeof ghRequest = async (endpoint) => {
    const path = endpoint.split("/contents/")[1]?.split("?")[0];
    const text = sources.get(path);
    assert.ok(text !== undefined);
    assert.equal(endpoint, `repos/acme/project/contents/${path}?ref=main`);
    return {
      type: "file",
      encoding: "base64",
      content: Buffer.from(text).toString("base64"),
    };
  };
  const handler = createGitHubFetchHandler({
    config: resolveFetchConfig({ github: { enabled: true } }).github,
    apiTimeoutMs: 5_000,
    runtime: { ghRequest: request },
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
    const request: typeof ghRequest = async (endpoint) => {
      if (endpoint === "repos/acme/project") return { default_branch: "main" };
      assert.equal(
        endpoint,
        kind === "blob"
          ? "repos/acme/project/contents/README.md?ref=main"
          : "repos/acme/project/readme?ref=main",
      );
      // Queue cancellation after API decoding, while the formatter is pending.
      setImmediate(() => controller.abort());
      return {
        type: "file",
        path: "README.md",
        encoding: "base64",
        content: Buffer.from("# Heading\n\n-   item\n").toString("base64"),
      };
    };
    const handler = createGitHubFetchHandler({
      config: { enabled: true },
      apiTimeoutMs: 5_000,
      runtime: { ghRequest: request },
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
