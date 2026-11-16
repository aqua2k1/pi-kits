import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readConfigSnapshot, resolveConfig } from "./config.ts";

async function snapshot(raw: unknown) {
  const directory = await mkdtemp(join(tmpdir(), "pi-web-config-keys-"));
  try {
    const path = join(directory, "pi-kits.json");
    await writeFile(path, JSON.stringify(raw));
    return await readConfigSnapshot(path);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("pi-web-kits configuration is read without introducing defaults into its raw snapshot", async () => {
  const raw = {
    enabled: false,
    search: { sources: { github: { enabled: false } }, maxResults: 3 },
  };
  const result = await snapshot({ "pi-web-kits": raw });
  assert.deepEqual(result.rawConfig, raw);
  assert.equal(result.source, "pi-kits");
  const config = resolveConfig(result.rawConfig, {});
  assert.equal(config.enabled, false);
  assert.equal(config.search.maxResults, 3);
  assert.equal(config.search.sources.github.enabled, false);
});

test("removed web-kits alias is ignored and cannot supply missing fields", async () => {
  const raw = {
    enabled: false,
    search: { maxResults: 2, sources: { github: { enabled: false } } },
  };
  const result = await snapshot({
    "web-kits": {
      enabled: true,
      search: {
        sources: {
          web: {
            routing: ["codex-alpha-search"],
            codex: { model: "ignored-model" },
          },
        },
      },
      fetch: { timeoutMs: 4000 },
    },
    "pi-web-kits": raw,
  });
  assert.deepEqual(result.rawConfig, raw);
  const config = resolveConfig(result.rawConfig, {});
  assert.equal(config.search.codexModel, "gpt-6-luna");
  assert.deepEqual(config.search.sources.web.routing, ["searxng"]);
  assert.equal(config.fetch.timeoutMs, 15000);
});

test("removed aliases remain unknown data, not configuration or validation inputs", async () => {
  for (const value of [
    null,
    { enabled: "false" },
    { search: { maxResults: 0 } },
  ]) {
    const result = await snapshot({ "web-kits": value });
    assert.deepEqual(result.rawConfig, {});
    assert.equal(resolveConfig(result.rawConfig, {}).enabled, true);
  }
});

test("canonical known invalid values fail instead of silently falling back", async () => {
  for (const value of [
    null,
    { enabled: "false" },
    { search: { maxResults: 0 } },
  ]) {
    await assert.rejects(snapshot({ "pi-web-kits": value }), {
      code: "invalid-config",
    });
  }
});

test("canonical configuration rejects a search with no enabled capability", async () => {
  await assert.rejects(
    snapshot({
      "pi-web-kits": {
        search: {
          sources: { web: { enabled: false }, github: { enabled: false } },
        },
      },
    }),
    { code: "invalid-config" },
  );
});
