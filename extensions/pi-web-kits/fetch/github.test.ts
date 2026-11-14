import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { test } from "node:test";
import { resolveFetchConfig } from "../config.ts";
import { GhRequestError } from "../shared/gh-request.ts";
import { MAX_GITHUB_TREE_ENTRIES } from "../shared/limits.ts";
import { GitHubHandler } from "./github.ts";

function setup(respond: (endpoint: string) => unknown, enabled = true) {
  const calls: string[] = [];
  const handler = new GitHubHandler({
    config: resolveFetchConfig({ github: { enabled } }).github,
    apiTimeoutMs: 5000,
    runtime: {
      now: () => 0,
      async ghRequest(endpoint) {
        calls.push(endpoint);
        if (endpoint.includes("matching-refs/heads/"))
          return [{ ref: "refs/heads/main" }];
        if (endpoint.includes("matching-refs/tags/")) return [];
        return respond(endpoint);
      },
    },
  });
  return { handler, calls };
}

for (const value of [null, [], false, "metadata"]) {
  test(`malformed repository metadata is rejected: ${JSON.stringify(value)}`, async () => {
    const { handler } = setup(() => value);
    await assert.rejects(
      handler.fetch({ url: new URL("https://github.com/acme/project") }),
      { code: "invalid-response" },
    );
  });
}

for (const suffix of ["", "/blob/main/file.txt", "/tree/main/src"]) {
  test(`missing GitHub resource rejects without fallback: ${suffix}`, async () => {
    const { handler } = setup(() => {
      throw new GhRequestError("status", 404);
    });
    await assert.rejects(
      handler.fetch({
        url: new URL(`https://github.com/acme/project${suffix}`),
      }),
      { code: "unsupported" },
    );
  });
}

for (const [error, code] of [
  [new GhRequestError("status", 403), "auth"],
  [new GhRequestError("status", 500), "network"],
  [new GhRequestError("timeout"), "timeout"],
  [new GhRequestError("cancelled"), "cancelled"],
  [new GhRequestError("rate-limit", 403), "rate-limit"],
] as const) {
  test(`root README operational ${code} failure is not ignored`, async () => {
    const { handler } = setup((endpoint) => {
      if (endpoint === "repos/acme/project") return { default_branch: "main" };
      throw error;
    });
    await assert.rejects(
      handler.fetch({ url: new URL("https://github.com/acme/project") }),
      { code },
    );
  });
}

test("null README JSON is invalid content, not a missing resource", async () => {
  const { handler } = setup((endpoint) =>
    endpoint === "repos/acme/project" ? { default_branch: "main" } : null,
  );
  await assert.rejects(
    handler.fetch({ url: new URL("https://github.com/acme/project") }),
    { code: "invalid-response" },
  );
});

async function fetched(handler: GitHubHandler, suffix: string) {
  const response = await handler.fetch({
    url: new URL(`https://github.com/acme/project${suffix}`),
  });
  assert.ok(response);
  try {
    assert.equal(response.source, "github-gh");
    assert.ok(!("repositoryPath" in response));
    assert.equal(
      await readFile(response.fullOutputPath, "utf8"),
      response.text,
    );
    return response;
  } finally {
    await rm(dirname(response.fullOutputPath), {
      recursive: true,
      force: true,
    });
  }
}

test("GitHub file reads use contents API without metadata or clone", async () => {
  const { handler, calls } = setup(() => ({
    type: "file",
    encoding: "base64",
    content: Buffer.from("hello world").toString("base64"),
  }));
  const response = await fetched(handler, "/blob/main/docs/file.txt");
  assert.equal(response.text, "hello world");
  assert.deepEqual(
    calls.filter((endpoint) => !endpoint.includes("matching-refs")),
    ["repos/acme/project/contents/docs/file.txt?ref=main"],
  );
});

test("GitHub directories list only the requested directory", async () => {
  const { handler, calls } = setup(() => [
    { type: "file", path: "src/index.ts" },
    { type: "dir", path: "src/nested" },
  ]);
  const response = await fetched(handler, "/tree/main/src");
  assert.ok(response.text.includes("src/index.ts"));
  assert.ok(response.text.includes("src/nested/"));
  assert.deepEqual(
    calls.filter((endpoint) => !endpoint.includes("matching-refs")),
    ["repos/acme/project/contents/src?ref=main"],
  );
});

test("GitHub repository root reads metadata and README, not the recursive tree", async () => {
  const { handler, calls } = setup((endpoint) =>
    endpoint.endsWith("/project")
      ? { default_branch: "main", description: "A useful project" }
      : {
          path: "README.md",
          content: Buffer.from("# Project\n").toString("base64"),
        },
  );
  const response = await fetched(handler, "");
  assert.ok(response.text.includes("A useful project"));
  assert.ok(response.text.includes("# Project"));
  assert.ok(response.text.includes("through bash"));
  assert.deepEqual(calls, [
    "repos/acme/project",
    "repos/acme/project/readme?ref=main",
  ]);
});

test("missing README preserves the repository overview", async () => {
  const handler = new GitHubHandler({
    config: { enabled: true },
    apiTimeoutMs: 5000,
    runtime: {
      async ghRequest(endpoint) {
        if (endpoint === "repos/acme/project")
          return { default_branch: "main", description: "No README" };
        throw new GhRequestError("status", 404);
      },
    },
  });
  const response = await fetched(handler, "");
  assert.ok(response.text.includes("No README"));
  assert.ok(!response.text.includes("## README"));
});

test("empty repositories still provide a metadata overview", async () => {
  const { handler, calls } = setup(() => ({
    description: "Empty repo",
    default_branch: null,
  }));
  assert.ok((await fetched(handler, "")).text.includes("Empty repo"));
  assert.equal(calls.length, 1);
});

test("directory output caps and signals truncation", async () => {
  const { handler } = setup(() =>
    Array.from({ length: MAX_GITHUB_TREE_ENTRIES + 1 }, (_, i) => ({
      type: "file",
      path: `src/file-${i}.ts`,
    })),
  );
  const response = await fetched(handler, "/tree/main/src");
  assert.ok(response.truncation);
  assert.ok(response.text.includes("may be truncated"));
});

test("binary files produce a bounded description", async () => {
  const { handler } = setup(() => ({
    type: "file",
    content: Buffer.from([0, 1, 2]).toString("base64"),
  }));
  assert.match(
    (await fetched(handler, "/blob/main/image.png")).text,
    /Binary file/,
  );
});

test("full SHA and encoded slash refs bypass discovery and are encoded in API calls", async () => {
  for (const ref of ["a".repeat(40), "feature%2Ftopic"]) {
    const { handler, calls } = setup(() => ({ type: "file", content: "" }));
    await fetched(handler, `/blob/${ref}/file.txt`);
    assert.deepEqual(calls, [
      `repos/acme/project/contents/file.txt?ref=${ref}`,
    ]);
  }
});

for (const value of [
  null,
  [],
  { type: "dir" },
  { type: "file", content: "", encoding: "none" },
  { type: "file", content: "%%%=" },
  { type: "file", content: "abc" },
]) {
  test(`malformed file response is rejected: ${JSON.stringify(value)}`, async () => {
    const { handler } = setup(() => value);
    await assert.rejects(
      handler.fetch({
        url: new URL("https://github.com/acme/project/blob/main/file.txt"),
      }),
      { code: "invalid-response" },
    );
  });
}

test("disabled and unsupported URLs do not invoke gh", async () => {
  const { handler, calls } = setup(
    () => assert.fail("must not execute"),
    false,
  );
  assert.equal(
    await handler.fetch({ url: new URL("https://github.com/acme/project") }),
    null,
  );
  assert.equal(calls.length, 0);
  const other = setup(() => assert.fail("must not execute"));
  assert.equal(
    await other.handler.fetch({
      url: new URL("https://github.com/acme/project/issues/1"),
    }),
    null,
  );
});

test("ambiguous refs produce an error rather than HTTP fallback", async () => {
  const { handler } = setup(() => []);
  await assert.rejects(
    handler.fetch({
      url: new URL(
        "https://github.com/acme/project/blob/missing/topic/file.txt",
      ),
    }),
    { code: "unsupported" },
  );
});

test("pre-cancelled GitHub reads do not execute commands", async () => {
  const { handler, calls } = setup(() => assert.fail("must not execute"));
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    handler.fetch(
      { url: new URL("https://github.com/acme/project") },
      controller.signal,
    ),
    { code: "cancelled" },
  );
  assert.equal(calls.length, 0);
});
