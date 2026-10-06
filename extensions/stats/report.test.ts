import assert from "node:assert/strict";
import { test } from "node:test";
import { aggregateEntries } from "./core.ts";
import { renderStatsHtml } from "./html.ts";
import { buildStatsReport } from "./report.ts";

function entry(id: string, date: Date, tokens: number) {
  return {
    type: "message",
    id,
    timestamp: date.getTime(),
    message: {
      role: "assistant",
      provider: "test",
      model: "model",
      usage: {
        input: tokens,
        output: 2,
        cacheRead: 3,
        cacheWrite: 4,
        cost: { total: 0.1 },
      },
    },
  };
}

test("report computes calendar summaries once in the local timezone", () => {
  const now = new Date(2026, 2, 1, 12);
  const snapshot = aggregateEntries([
    entry("previous", new Date(2026, 1, 28, 23, 59), 10),
    entry("today", new Date(2026, 2, 1, 0), 20),
    entry("today-two", new Date(2026, 2, 1, 11), 30),
    entry("older", new Date(2024, 1, 29, 12), 40),
  ]);
  const report = buildStatsReport(snapshot, now);
  assert.equal(report.calendar.today, "2026-03-01");
  assert.equal(report.calendar.month, "2026-03");
  assert.equal(report.calendar.todayTokens, 68);
  assert.equal(report.calendar.monthTokens, 68);
  assert.equal(report.total.totalTokens, 136);
  assert.deepEqual(report.calendar.years, [2024, 2026]);
  assert.deepEqual(report.calendar.totalsByDate["2026-03-01"], {
    totalTokens: 68,
    cost: 0.2,
  });
});

test("HTML renders the prepared report without recalculating or mutating it", () => {
  const snapshot = aggregateEntries([
    entry("one", new Date(2026, 0, 2, 12), 100),
  ]);
  const report = buildStatsReport(snapshot, new Date(2026, 0, 2, 13));
  const prepared = JSON.stringify(report);
  snapshot.total.totalTokens = 999;
  snapshot.byDate.clear();
  snapshot.byTimestamp.clear();
  const html = renderStatsHtml(report);
  const json = html.match(
    /<script id="stats-data" type="application\/json">(.*?)<\/script>/s,
  )?.[1];
  assert.ok(json);
  assert.deepEqual(JSON.parse(json), report);
  assert.equal(JSON.stringify(report), prepared);
});

test("empty reports include current year and zero calendar totals", () => {
  const report = buildStatsReport(aggregateEntries([]), new Date(2026, 0, 1));
  assert.deepEqual(report.calendar.years, [2026]);
  assert.equal(report.calendar.todayTokens, 0);
  assert.equal(report.calendar.monthTokens, 0);
  assert.deepEqual(report.calendar.byDate, {});
});
