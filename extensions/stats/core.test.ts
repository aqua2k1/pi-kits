import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  addSessionEntry,
  aggregateEntries,
  createStatsSnapshot,
  dateKey,
  findSessionFiles,
  OTHER_MODEL,
  scanSessionFiles,
  totalsForDate,
  totalsForModel,
  totalsForTimeRange,
} from "./core.ts";

function usage(
  input: number,
  output: number,
  cost: number,
  cacheRead = 0,
  cacheWrite = 0,
) {
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: input + output + cacheRead + cacheWrite,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
  };
}

function assertTotals(
  actual: { totalTokens: number; cost: number },
  totalTokens: number,
  cost: number,
): void {
  assert.equal(actual.totalTokens, totalTokens);
  assert.ok(Math.abs(actual.cost - cost) < 1e-10);
}

function assistantEntry(
  id: string,
  timestamp: string,
  provider: string,
  model: string,
  assistantUsage: ReturnType<typeof usage>,
  responseModel?: string,
) {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp,
    message: {
      role: "assistant",
      provider,
      model,
      ...(responseModel ? { responseModel } : {}),
      usage: assistantUsage,
    },
  };
}

test("aggregateEntries groups total and cost by model and date", () => {
  const day = "2026-01-02T12:00:00.000Z";
  const entries = [
    { type: "session", id: "session-1" },
    assistantEntry("a", day, "openai", "gpt", usage(100, 20, 0.1, 30)),
    assistantEntry("b", day, "openai", "gpt", usage(10, 5, 0.02)),
    assistantEntry("c", day, "anthropic", "sonnet", usage(7, 3, 0.03)),
    {
      type: "message",
      id: "tool",
      parentId: null,
      timestamp: day,
      message: { role: "toolResult", usage: usage(4, 1, 0.01) },
    },
    {
      type: "compaction",
      id: "summary",
      parentId: null,
      timestamp: day,
      usage: usage(2, 2, 0.01),
    },
  ];

  const snapshot = aggregateEntries(entries);
  assert.equal(snapshot.sessionsScanned, 1);
  assert.equal(snapshot.usageEntries, 5);
  assertTotals(totalsForModel(snapshot, "openai/gpt"), 165, 0.12);
  assertTotals(totalsForModel(snapshot, "anthropic/sonnet"), 10, 0.03);
  assertTotals(totalsForModel(snapshot, OTHER_MODEL), 9, 0.02);
  const dayValue = dateKey(day);
  assert.ok(dayValue);
  assertTotals(totalsForDate(snapshot, dayValue, "openai/gpt"), 165, 0.12);
  assertTotals(snapshot.total, 184, 0.17);
});

test("aggregateEntries prefers responseModel and deduplicates copied entries", () => {
  const entry = assistantEntry(
    "same-entry",
    "2026-01-03T12:00:00.000Z",
    "router",
    "alias",
    usage(10, 2, 0.01),
    "actual-model",
  );
  const collision = assistantEntry(
    "same-entry",
    "2026-01-03T12:00:00.000Z",
    "router",
    "different-model",
    usage(5, 1, 0.02),
  );
  const snapshot = aggregateEntries([
    entry,
    { ...entry },
    { ...entry },
    collision,
  ]);

  assertTotals(totalsForModel(snapshot, "router/actual-model"), 12, 0.01);
  assertTotals(totalsForModel(snapshot, "router/different-model"), 6, 0.02);
  assert.equal(snapshot.byModel.has("router/alias"), false);
  assert.equal(snapshot.usageEntries, 2);
});

test("addSessionEntry ignores messages without billable usage", () => {
  const snapshot = createStatsSnapshot();
  const seen = new Set<string>();

  assert.equal(
    addSessionEntry(
      snapshot,
      assistantEntry(
        "zero",
        "2026-01-03T12:00:00.000Z",
        "p",
        "m",
        usage(0, 0, 0),
      ),
      seen,
    ),
    false,
  );
  assert.equal(snapshot.usageEntries, 0);
});

test("totalsForTimeRange supports rolling windows across dates", () => {
  const end = new Date("2026-01-31T12:00:00.000Z").getTime();
  const snapshot = aggregateEntries([
    assistantEntry(
      "inside",
      "2026-01-30T13:00:00.000Z",
      "p",
      "m",
      usage(10, 2, 0.01),
    ),
    assistantEntry(
      "outside",
      "2026-01-30T11:00:00.000Z",
      "p",
      "m",
      usage(20, 2, 0.02),
    ),
  ]);

  assertTotals(
    totalsForTimeRange(snapshot, end - 24 * 60 * 60 * 1000, end),
    12,
    0.01,
  );
  assertTotals(
    totalsForTimeRange(snapshot, end - 30 * 24 * 60 * 60 * 1000, end, "p/m"),
    34,
    0.03,
  );
});

test("scanSessionFiles counts copied fork history once", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "pi-stats-fork-"));
  try {
    const parent = path.join(root, "parent.jsonl");
    const fork = path.join(root, "fork.jsonl");
    const timestamp = "2026-01-05T12:00:00.000Z";
    const shared = assistantEntry(
      "shared",
      timestamp,
      "p",
      "m",
      usage(10, 2, 0.01),
    );
    const parentOnly = assistantEntry(
      "parent-only",
      timestamp,
      "p",
      "m",
      usage(4, 1, 0.01),
    );
    const forkOnly = assistantEntry(
      "fork-only",
      timestamp,
      "p",
      "m",
      usage(6, 1, 0.01),
    );

    writeFileSync(
      parent,
      `${JSON.stringify({ type: "session", id: "parent" })}\n${JSON.stringify(shared)}\n${JSON.stringify(parentOnly)}\n`,
    );
    writeFileSync(
      fork,
      `${JSON.stringify({ type: "session", id: "fork", parentSession: parent })}\n${JSON.stringify(shared)}\n${JSON.stringify(forkOnly)}\n`,
    );

    const snapshot = await scanSessionFiles([parent, fork]);
    assertTotals(totalsForModel(snapshot, "p/m"), 24, 0.03);
    assert.equal(snapshot.usageEntries, 3);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("scanSessionFiles reads nested session files and reports progress", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "pi-stats-"));
  try {
    const nested = path.join(root, "project", "tasks");
    const first = path.join(root, "first.jsonl");
    const second = path.join(nested, "second.jsonl");
    const timestamp = "2026-01-04T12:00:00.000Z";

    mkdirSync(nested, { recursive: true });
    writeFileSync(
      first,
      `${JSON.stringify({ type: "session", id: "s1" })}\n${JSON.stringify(assistantEntry("a", timestamp, "p", "m", usage(5, 1, 0.02)))}\n`,
    );
    writeFileSync(
      second,
      `${JSON.stringify({ type: "session", id: "s2" })}\nnot json\n${JSON.stringify(assistantEntry("b", timestamp, "p", "m", usage(2, 1, 0.01)))}\n`,
    );

    const files = await findSessionFiles(root);
    assert.deepEqual(files, [first, second]);
    const progress: Array<[number, number]> = [];
    const snapshot = await scanSessionFiles(files, (completed, total) => {
      progress.push([completed, total]);
    });

    assert.deepEqual(progress, [
      [1, 2],
      [2, 2],
    ]);
    assert.equal(snapshot.sessionsScanned, 2);
    assert.equal(snapshot.malformedLines, 1);
    assertTotals(totalsForModel(snapshot, "p/m"), 9, 0.03);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
