import assert from "node:assert/strict";
import { readFile, rm, stat } from "node:fs/promises";
import { test } from "node:test";
import { fetchWeb } from "../composition.ts";
import { resolveConfig } from "../config.ts";
import { GhRequestError } from "../shared/gh-request.ts";
import { TEMP_SPOOL_TTL_MS } from "../shared/limits.ts";
import { WebFetchError } from "./errors.ts";
import { normalizeFetchRequest } from "./router.ts";

async function cleanup(path: string): Promise<void> {
  await rm(path.substring(0, path.lastIndexOf("/")), {
    recursive: true,
    force: true,
  });
}

test("normalizeFetchRequest accepts HTTP(S) and rejects unsafe schemes", () => {
  assert.equal(
    normalizeFetchRequest({ url: "https://example.com/a" }).url.hostname,
    "example.com",
  );
  assert.throws(
    () => normalizeFetchRequest({ url: "file:///etc/passwd" }),
    (error: unknown) =>
      error instanceof WebFetchError && error.code === "blocked-url",
  );
  assert.throws(
    () => normalizeFetchRequest({ url: "https://user:pass@example.com" }),
    (error: unknown) =>
      error instanceof WebFetchError && error.code === "blocked-url",
  );
});

test("fetchWeb uses native HTTP for ordinary URLs and saves full text", async () => {
  const config = resolveConfig({}, {}).fetch;
  const response = await fetchWeb({ url: "https://example.com/page" }, config, {
    fetch: async () =>
      new Response("hello world", {
        headers: { "content-type": "text/plain" },
      }),
    now: () => 0,
  });
  try {
    assert.equal(response.source, "native-http");
    assert.equal(response.text, "hello world");
    assert.equal(response.expiresAt, new Date(TEMP_SPOOL_TTL_MS).toISOString());
    assert.equal(
      await readFile(response.fullOutputPath, "utf8"),
      "hello world",
    );
    assert.equal(await stat(response.fullOutputPath).then(() => true), true);
  } finally {
    await cleanup(response.fullOutputPath);
  }
});

test("GitHub API failures never fall back to native HTTP", async () => {
  let httpCalls = 0;
  await assert.rejects(
    fetchWeb(
      { url: "https://github.com/acme/project" },
      resolveConfig({}, {}).fetch,
      {
        async ghRequest() {
          throw new GhRequestError("tool-unavailable");
        },
        fetch: async () => {
          httpCalls++;
          return new Response("login");
        },
      },
    ),
    { code: "tool-unavailable" },
  );
  assert.equal(httpCalls, 0);
});
