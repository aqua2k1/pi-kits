import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  getConfigPath,
  parseConfig,
  readConfig,
  readConfigSnapshot,
  resolveConfig,
  resolveFetchConfig,
  resolveSearchConfig,
} from "./config.ts";
import { WebSearchError } from "./search/errors.ts";
import { CODEX_DEFAULT_MODEL } from "./search/providers/codex/config.ts";
import { SEARXNG_DEFAULT_URL } from "./search/providers/searxng/config.ts";
import {
  DEFAULT_FETCH_TIMEOUT_MS,
  DEFAULT_GITHUB_ENABLED,
  DEFAULT_MAX_RESULTS,
  DEFAULT_SEARCH_TIMEOUT_MS,
} from "./shared/limits.ts";

function invalidConfig(error: unknown): boolean {
  return error instanceof WebSearchError && error.code === "invalid-config";
}

test("new sources survive parsing, file loading and shared resolution", async () => {
  const search = {
    enabled: true,
    maxResults: 3,
    timeoutMs: 4000,
    sources: {
      web: {
        enabled: true,
        routing: ["codex-alpha-search", "searxng"] as (
          | "codex-alpha-search"
          | "searxng"
        )[],
        codex: { model: "custom-model" },
      },
      github: { enabled: false },
    },
  };
  const parsed = parseConfig(JSON.stringify({ search }));
  assert.deepEqual(parsed.search, search);
  const resolved = resolveSearchConfig(search, {});
  assert.deepEqual(resolved.sources, {
    web: { enabled: true, routing: ["codex-alpha-search", "searxng"] },
    github: { enabled: false },
  });
  assert.equal(resolved.provider, "codex-alpha-search");
  assert.equal(resolved.fallback, true);
  assert.equal(resolved.fallbackProvider, "searxng");
  assert.equal(resolved.codexModel, "custom-model");
  await withConfigDirectory(async (directory) => {
    await writeFile(
      getConfigPath(directory),
      JSON.stringify({ "web-kits": { search } }),
    );
    const raw = await readConfig(getConfigPath(directory));
    assert.deepEqual(raw, { search });
    assert.deepEqual(resolveConfig(raw, {}).search, resolved);
  });
  assert.deepEqual(resolveSearchConfig({}, {}).sources, {
    web: { enabled: true, routing: ["searxng"] },
    github: { enabled: true },
  });
});

test("new sources reject invalid and mixed settings through all extension entries", async () => {
  for (const search of [
    { sources: { web: { routing: [] } } },
    { sources: { web: { routing: ["searxng", "searxng"] } } },
    { sources: { web: { routing: ["unknown"] } } },
    { sources: { web: { enabled: "false" } } },
    { sources: { github: false } },
    { sources: { web: {} }, routing: {} },
    { sources: { web: {} }, codex: {} },
    { sources: { web: { enabled: false }, github: { enabled: false } } },
    { sources: { web: { codex: { model: "bad model" } } } },
    { sources: { web: { searxng: { apiKey: "synthetic-secret" } } } },
  ]) {
    assert.throws(() => parseConfig(JSON.stringify({ search })), invalidConfig);
    assert.throws(
      () => resolveSearchConfig(search as never, {}),
      invalidConfig,
    );
    await withConfigDirectory(async (directory) => {
      await writeFile(
        getConfigPath(directory),
        JSON.stringify({ "web-kits": { search } }),
      );
      await assert.rejects(readConfig(getConfigPath(directory)), invalidConfig);
    });
  }
  assert.equal(
    resolveSearchConfig(
      {
        enabled: false,
        sources: { web: { enabled: false }, github: { enabled: false } },
      },
      {},
    ).enabled,
    false,
  );
  assert.equal(
    resolveSearchConfig(
      {
        sources: { web: { enabled: false } },
      },
      {},
    ).sources.github.enabled,
    true,
  );
});

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
        },
      },
    },
  );
  assert.throws(() => parseConfig("[]"), invalidConfig);
  assert.deepEqual(
    parseConfig(
      JSON.stringify({ routing: { provider: "searxng" }, future: true }),
    ),
    {},
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
    () => parseConfig(JSON.stringify({ fetch: { github: { enabled: 42 } } })),
    invalidConfig,
  );
});

test("getConfigPath: uses pi-kits.json under the agent directory", () => {
  assert.equal(
    getConfigPath("/synthetic/agent"),
    "/synthetic/agent/pi-kits.json",
  );
});

test("resolveConfig: applies independent search and fetch defaults", () => {
  const config = resolveConfig({}, {});
  assert.equal(config.enabled, true);
  assert.equal(config.search.enabled, true);
  assert.equal(config.fetch.enabled, true);
  assert.equal(config.search.provider, "searxng");
  assert.equal(config.search.fallback, false);
  assert.equal(config.search.searxngUrl, SEARXNG_DEFAULT_URL);
  assert.equal(config.search.timeoutMs, DEFAULT_SEARCH_TIMEOUT_MS);
  assert.equal(config.search.maxResults, DEFAULT_MAX_RESULTS);
  assert.equal(config.search.codexModel, CODEX_DEFAULT_MODEL);
  assert.equal(config.fetch.timeoutMs, DEFAULT_FETCH_TIMEOUT_MS);
  assert.equal(config.fetch.github.enabled, DEFAULT_GITHUB_ENABLED);
  assert.deepEqual(config.fetch.github, { enabled: DEFAULT_GITHUB_ENABLED });
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
    enabled: true,
    sources: {
      web: { enabled: true, routing: ["codex-alpha-search", "searxng"] },
      github: { enabled: true },
    },
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

test("resolveFetchConfig: retains only the GitHub enabled switch", () => {
  assert.deepEqual(
    resolveFetchConfig({ timeoutMs: 5_000, github: { enabled: false } }),
    { enabled: true, timeoutMs: 5_000, github: { enabled: false } },
  );
});

test("obsolete GitHub settings are ignored, including invalid types", async () => {
  for (const enabled of [true, false]) {
    const github = {
      enabled,
      mode: { invalid: true },
      maxRepoSizeMB: "invalid",
      cloneTimeoutSeconds: null,
      clonePath: 42,
    };
    const parsed = parseConfig(JSON.stringify({ fetch: { github } }));
    assert.deepEqual(parsed, { fetch: { github: { enabled } } });
    assert.deepEqual(resolveFetchConfig({ github }).github, { enabled });
    await withConfigDirectory(async (directory) => {
      await writeFile(
        getConfigPath(directory),
        JSON.stringify({ "web-kits": { fetch: { github } } }),
      );
      const snapshot = await readConfigSnapshot(getConfigPath(directory));
      assert.deepEqual(snapshot.rawConfig.fetch?.github, { enabled });
      assert.deepEqual(resolveConfig(snapshot.rawConfig, {}).fetch.github, {
        enabled,
      });
    });
  }
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

async function withConfigDirectory(
  run: (directory: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "pi-web-unified-config-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("unified config: web section is read without merging old files", async () => {
  await withConfigDirectory(async (directory) => {
    await writeFile(
      join(directory, "web-tools-config.json"),
      JSON.stringify({ search: { maxResults: 9 }, fetch: { timeoutMs: 4000 } }),
    );
    await writeFile(
      getConfigPath(directory),
      JSON.stringify({ "web-kits": { search: { maxResults: 2 } } }),
    );
    const snapshot = await readConfigSnapshot(getConfigPath(directory));
    assert.equal(snapshot.source, "pi-kits");
    assert.equal(snapshot.configPath, getConfigPath(directory));
    assert.deepEqual(snapshot.rawConfig, { search: { maxResults: 2 } });
    assert.deepEqual(
      await readConfig(join(directory, "web-tools-config.json")),
      {},
    );
    assert.equal(
      resolveConfig(snapshot.rawConfig, {}).fetch.timeoutMs,
      DEFAULT_FETCH_TIMEOUT_MS,
    );
  });
});

test("unified config: omitted web uses defaults and ignores malformed old files", async () => {
  await withConfigDirectory(async (directory) => {
    await writeFile(join(directory, "web-tools-config.json"), "not-json");
    await writeFile(getConfigPath(directory), "{}");
    assert.deepEqual(await readConfig(getConfigPath(directory)), {});
    assert.equal(
      (await readConfigSnapshot(getConfigPath(directory))).source,
      "pi-kits",
    );
  });
});

test("unified config: missing file uses defaults and never reads old files", async () => {
  await withConfigDirectory(async (directory) => {
    const path = getConfigPath(directory);
    const expected = { rawConfig: {}, configPath: path, source: "defaults" };
    assert.deepEqual(await readConfigSnapshot(path), expected);
    const oldPath = join(directory, "web-tools-config.json");
    await writeFile(oldPath, JSON.stringify({ search: { maxResults: 3 } }));
    assert.deepEqual(await readConfigSnapshot(path), expected);
    await writeFile(oldPath, "not-json");
    assert.deepEqual(await readConfigSnapshot(path), expected);
    assert.equal(
      resolveConfig(await readConfig(path), {}).search.enabled,
      true,
    );
    await assert.rejects(readConfig(oldPath), invalidConfig);
  });
});

test("unified config: explicit paths read exactly that file using the root schema", async () => {
  await withConfigDirectory(async (directory) => {
    await writeFile(getConfigPath(directory), '{"web-kits":{"enabled":false}}');
    const path = join(directory, "custom-config.json");
    assert.deepEqual(await readConfigSnapshot(path), {
      rawConfig: {},
      configPath: path,
      source: "defaults",
    });
    await writeFile(path, '{"web-kits":{"search":{"maxResults":4}}}');
    assert.deepEqual(await readConfigSnapshot(path), {
      rawConfig: { search: { maxResults: 4 } },
      configPath: path,
      source: "pi-kits",
    });
    for (const text of ['{"search":{}}', '{"fetch":{}}', '{"enabled":false}']) {
      await writeFile(path, text);
      assert.deepEqual(await readConfig(path), {});
    }
    await writeFile(path, "not-json");
    await assert.rejects(readConfig(path), invalidConfig);
    await assert.rejects(readConfig(directory), invalidConfig);
  });
});

test("unified config: invalid new files never fall back", async () => {
  await withConfigDirectory(async (directory) => {
    await writeFile(join(directory, "web-tools-config.json"), "{}");
    for (const text of [
      "not-json",
      "[]",
      '{"web-kits":null}',
      '{"web-kits":{"enabled":"false"}}',
      '{"web-kits":{"search":{"enabled":0}}}',
      '{"web-kits":{"fetch":{"enabled":null}}}',
      '{"web-kits":{"search":{"maxResults":0}}}',
      '{"web-kits":{"search":{"searxng":{"apiKey":"synthetic-secret"}}}}',
    ]) {
      await writeFile(getConfigPath(directory), text);
      await assert.rejects(
        readConfig(getConfigPath(directory)),
        (error: unknown) =>
          invalidConfig(error) && !String(error).includes("synthetic-secret"),
      );
    }
    // Shared validation also rejects routing conflicts before file loading.
    await writeFile(
      getConfigPath(directory),
      '{"web-kits":{"search":{"routing":{"provider":"searxng","fallbackProvider":"searxng"}}}}',
    );
    await assert.rejects(readConfig(getConfigPath(directory)), invalidConfig);
  });
});

test("unified config: enabled switches survive reading and default independently", async () => {
  await withConfigDirectory(async (directory) => {
    await writeFile(
      getConfigPath(directory),
      JSON.stringify({
        "web-kits": {
          enabled: false,
          search: { enabled: false },
          fetch: { enabled: false },
        },
      }),
    );
    const config = resolveConfig(
      await readConfig(getConfigPath(directory)),
      {},
    );
    assert.equal(config.enabled, false);
    assert.equal(config.search.enabled, false);
    assert.equal(config.fetch.enabled, false);
    assert.equal(
      resolveConfig({ search: { enabled: false } }, {}).fetch.enabled,
      true,
    );
    assert.equal(
      resolveConfig({ fetch: { enabled: false } }, {}).search.enabled,
      true,
    );
  });
});
