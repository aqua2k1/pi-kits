import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { aggregateEntries } from "./core.ts";
import {
  renderStatsHtml,
  serializeStatsSnapshot,
  writeStatsHtmlSnapshot,
} from "./html.ts";

function usage(input: number, output: number, cost: number) {
  return {
    input,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: input + output,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
  };
}

function assistantEntry(
  id: string,
  timestamp: string,
  provider: string,
  model: string,
  assistantUsage: ReturnType<typeof usage>,
) {
  return {
    type: "message",
    id,
    timestamp,
    message: {
      role: "assistant",
      provider,
      model,
      usage: assistantUsage,
    },
  };
}

test("serializeStatsSnapshot produces JSON-safe model and date data", () => {
  const snapshot = aggregateEntries([
    assistantEntry(
      "one",
      "2026-01-02T12:00:00.000Z",
      "openai",
      "gpt",
      usage(100, 20, 0.1),
    ),
    assistantEntry(
      "two",
      "2026-01-03T12:00:00.000Z",
      "anthropic",
      "sonnet",
      usage(30, 10, 0.05),
    ),
  ]);

  const data = serializeStatsSnapshot(
    snapshot,
    new Date("2026-01-04T00:00:00.000Z"),
  );

  assert.equal(data.generatedAt, "2026-01-04T00:00:00.000Z");
  assert.deepEqual(data.models, [
    { model: "openai/gpt", totalTokens: 120, cost: 0.1 },
    { model: "anthropic/sonnet", totalTokens: 40, cost: 0.05 },
  ]);
  assert.deepEqual(data.dates, [
    {
      day: "2026-01-02",
      models: [{ model: "openai/gpt", totalTokens: 120, cost: 0.1 }],
    },
    {
      day: "2026-01-03",
      models: [{ model: "anthropic/sonnet", totalTokens: 40, cost: 0.05 }],
    },
  ]);
  assert.equal(data.total.totalTokens, 160);
  assert.ok(Math.abs(data.total.cost - 0.15) < 1e-10);
  assert.equal(data.periods.last30Days.total.totalTokens, 160);
  assert.ok(Math.abs(data.periods.last30Days.total.cost - 0.15) < 1e-10);
  assert.deepEqual(data.periods.last30Days.models, data.models);
  assert.deepEqual(data.periods.last24Hours, {
    total: { totalTokens: 40, cost: 0.05 },
    models: [{ model: "anthropic/sonnet", totalTokens: 40, cost: 0.05 }],
  });
});

test("serializeStatsSnapshot calculates rolling period totals per model", () => {
  const snapshot = aggregateEntries([
    assistantEntry(
      "recent",
      "2026-01-31T10:00:00.000Z",
      "openai",
      "gpt",
      usage(10, 5, 0.01),
    ),
    assistantEntry(
      "yesterday",
      "2026-01-30T11:00:00.000Z",
      "anthropic",
      "sonnet",
      usage(20, 5, 0.02),
    ),
    assistantEntry(
      "old",
      "2025-12-30T12:00:00.000Z",
      "openai",
      "gpt",
      usage(30, 5, 0.03),
    ),
  ]);

  const data = serializeStatsSnapshot(
    snapshot,
    new Date("2026-01-31T12:00:00.000Z"),
  );

  assert.deepEqual(data.periods.last24Hours, {
    total: { totalTokens: 15, cost: 0.01 },
    models: [{ model: "openai/gpt", totalTokens: 15, cost: 0.01 }],
  });
  assert.deepEqual(data.periods.last30Days, {
    total: { totalTokens: 40, cost: 0.03 },
    models: [
      { model: "anthropic/sonnet", totalTokens: 25, cost: 0.02 },
      { model: "openai/gpt", totalTokens: 15, cost: 0.01 },
    ],
  });
});

test("renderStatsHtml is self-contained and includes model bars", () => {
  const snapshot = aggregateEntries([
    assistantEntry(
      "one",
      "2026-01-02T12:00:00.000Z",
      "openai",
      "gpt",
      usage(100, 20, 0.1),
    ),
  ]);
  const html = renderStatsHtml(snapshot, new Date("2026-01-04T00:00:00.000Z"));

  assert.match(html, /<title>Pi Token Usage Stats<\/title>/);
  assert.match(html, /Usage by model/);
  assert.match(html, /Last 30 days/);
  assert.match(html, /Last 24 hours/);
  assert.match(html, /id="summary-24h-tokens"/);
  assert.match(html, /id="model-bars"/);
  assert.match(html, /"model":"openai\/gpt"/);
  assert.doesNotMatch(html, /\{\{STATS_DATA\}\}/);
  assert.doesNotMatch(html, /<script[^>]+src=/);
  assert.doesNotMatch(html, /<link[^>]+href=/);
});

test("writeStatsHtmlSnapshot writes a browser-ready snapshot file", async () => {
  const snapshot = aggregateEntries([]);
  const filePath = await writeStatsHtmlSnapshot(
    snapshot,
    new Date("2026-01-04T00:00:00.000Z"),
  );

  try {
    assert.equal(path.basename(filePath), "stats.html");
    assert.match(readFileSync(filePath, "utf8"), /Pi Token Usage Stats/);
  } finally {
    rmSync(path.dirname(filePath), { recursive: true, force: true });
  }
});
