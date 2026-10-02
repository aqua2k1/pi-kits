import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  getConfigPath,
  parseConfig,
  readConfig,
  resolveConfig,
  resolveFetchConfig,
  resolveSearchConfig,
} from "./config.ts";
import { WebSearchError } from "./core/errors.ts";
import { CODEX_DEFAULT_MODEL } from "./providers/codex/config.ts";
import { SEARXNG_DEFAULT_URL } from "./providers/searxng/config.ts";
import {
  DEFAULT_FETCH_TIMEOUT_MS,
  DEFAULT_GITHUB_CLONE_TIMEOUT_SECONDS,
  DEFAULT_GITHUB_ENABLED,
  DEFAULT_GITHUB_MAX_REPO_SIZE_MB,
  DEFAULT_MAX_RESULTS,
  DEFAULT_SEARCH_TIMEOUT_MS,
} from "./shared/limits.ts";

function invalidConfig(error: unknown): boolean {
  return error instanceof WebSearchError && error.code === "invalid-config";
}

test("parseConfig: separates search and fetch settings", () => {
  assert.deepEqual(
    parseConfig(
      JSON.stringify({
        search: {
          routing: {
            provider: "codex-alpha-search",
            fallback: true,
            fallbackProvider: "searxng",
          },
          timeoutMs: 20_000,
          maxResults: 8,
          codex: { model: "synthetic-model", bad: true },
        },
        fetch: {
          timeoutMs: 10_000,
          github: {
            enabled: true,
            mode: "clone",
            maxRepoSizeMB: 100,
            cloneTimeoutSeconds: 60,
          },
        },
        unknown: "ignored",
      }),
    ),
    {
      search: {
        routing: {
          provider: "codex-alpha-search",
          fallback: true,
          fallbackProvider: "searxng",
        },
        timeoutMs: 20_000,
        maxResults: 8,
        codex: { model: "synthetic-model" },
      },
      fetch: {
        timeoutMs: 10_000,
        github: {
          enabled: true,
          mode: "clone",
          maxRepoSizeMB: 100,
          cloneTimeoutSeconds: 60,
        },
      },
    },
  );
  assert.throws(() => parseConfig("[]"), invalidConfig);
  assert.throws(
    () => parseConfig(JSON.stringify({ routing: { provider: "searxng" } })),
    invalidConfig,
  );
});

test("parseConfig: rejects search secrets in JSON", () => {
  for (const field of ["url", "apiKey"]) {
    assert.throws(
      () =>
        parseConfig(
          JSON.stringify({
            search: { searxng: { [field]: "synthetic-secret" } },
          }),
        ),
      (error: unknown) =>
        invalidConfig(error) && !String(error).includes("synthetic-secret"),
    );
  }
});

test("parseConfig: rejects malformed JSON and known field types safely", () => {
  assert.throws(() => parseConfig("not-json"), invalidConfig);
  assert.throws(
    () => parseConfig(JSON.stringify({ search: { timeoutMs: "no" } })),
    invalidConfig,
  );
  assert.throws(
    () => parseConfig(JSON.stringify({ fetch: { github: "no" } })),
    invalidConfig,
  );
  assert.throws(
    () => parseConfig(JSON.stringify({ fetch: { github: { mode: 42 } } })),
    invalidConfig,
  );
});

test("getConfigPath: uses web-tools-config.json under the agent directory", () => {
  assert.equal(
    getConfigPath("/synthetic/agent"),
    "/synthetic/agent/web-tools-config.json",
  );
});

test("resolveConfig: applies independent search and fetch defaults", () => {
  const config = resolveConfig({}, {});
  assert.equal(config.search.provider, "searxng");
  assert.equal(config.search.fallback, false);
  assert.equal(config.search.searxngUrl, SEARXNG_DEFAULT_URL);
  assert.equal(config.search.timeoutMs, DEFAULT_SEARCH_TIMEOUT_MS);
  assert.equal(config.search.maxResults, DEFAULT_MAX_RESULTS);
  assert.equal(config.search.codexModel, CODEX_DEFAULT_MODEL);
  assert.equal(config.fetch.timeoutMs, DEFAULT_FETCH_TIMEOUT_MS);
  assert.equal(config.fetch.github.enabled, DEFAULT_GITHUB_ENABLED);
  assert.equal(
    config.fetch.github.maxRepoSizeMB,
    DEFAULT_GITHUB_MAX_REPO_SIZE_MB,
  );
  assert.equal(
    config.fetch.github.cloneTimeoutSeconds,
    DEFAULT_GITHUB_CLONE_TIMEOUT_SECONDS,
  );
});

test("resolveSearchConfig: reads search settings and secrets only from env", () => {
  const config = resolveSearchConfig(
    {
      routing: {
        provider: "codex",
        fallback: true,
        fallbackProvider: "searxng",
      },
      timeoutMs: 5_000,
      maxResults: 2,
      codex: { model: "synthetic-config-model" },
    },
    {
      SEARXNG_URL: "https://env.example/search",
      SEARXNG_API_KEY: "synthetic-env-key",
    },
  );
  assert.deepEqual(config, {
    provider: "codex-alpha-search",
    fallback: true,
    fallbackProvider: "searxng",
    timeoutMs: 5_000,
    maxResults: 2,
    searxngUrl: "https://env.example/search",
    searxngApiKey: "synthetic-env-key",
    codexModel: "synthetic-config-model",
  });
});

test("resolveFetchConfig: validates GitHub clone settings", () => {
  const config = resolveFetchConfig({
    timeoutMs: 5_000,
    github: {
      enabled: true,
      mode: "clone",
      maxRepoSizeMB: 42,
      cloneTimeoutSeconds: 20,
      clonePath: "/tmp/synthetic-clones",
    },
  });
  assert.deepEqual(config, {
    timeoutMs: 5_000,
    github: {
      enabled: true,
      mode: "clone",
      maxRepoSizeMB: 42,
      cloneTimeoutSeconds: 20,
      clonePath: "/tmp/synthetic-clones",
    },
  });
  assert.throws(
    () => resolveFetchConfig({ github: { mode: "invalid" as never } }),
    invalidConfig,
  );
});

test("resolveSearchConfig: validates search values", () => {
  assert.throws(
    () => resolveSearchConfig({ routing: { provider: "unknown" } }, {}),
    invalidConfig,
  );
  assert.throws(
    () => resolveSearchConfig({ timeoutMs: 999 }, {}),
    invalidConfig,
  );
  assert.throws(
    () => resolveSearchConfig({ maxResults: 11 }, {}),
    invalidConfig,
  );
  assert.throws(
    () => resolveSearchConfig({ routing: { fallbackProvider: "searxng" } }, {}),
    invalidConfig,
  );
  assert.throws(
    () =>
      resolveSearchConfig(
        { routing: { provider: "searxng", fallbackProvider: "searxng" } },
        {},
      ),
    invalidConfig,
  );
});

test("config file: missing is optional; other read failures are classified", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-web-tools-read-"));
  try {
    const path = getConfigPath(directory);
    assert.deepEqual(await readConfig(path), {});
    assert.throws(() => parseConfig('{"search":'), invalidConfig);
    await assert.rejects(readConfig(directory), (error: unknown) =>
      invalidConfig(error),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
