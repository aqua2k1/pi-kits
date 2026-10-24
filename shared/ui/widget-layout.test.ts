import assert from "node:assert/strict";
import { test } from "node:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { layoutWidgetParts } from "./widget-layout.ts";

test("sorts by ascending priority then id without modifying input", () => {
  const parts = Object.freeze([
    Object.freeze({ id: "z", priority: 20, text: "Z" }),
    Object.freeze({ id: "b", priority: 10, text: "B" }),
    Object.freeze({ id: "a", priority: 10, text: "A" }),
    Object.freeze({ id: "first", priority: -1, text: "FIRST" }),
  ]);
  assert.deepEqual(layoutWidgetParts(parts, 10), ["FIRST    A", "B        Z"]);
  assert.equal(parts[0].id, "z");
  assert.deepEqual(
    layoutWidgetParts([...parts].reverse(), 10),
    layoutWidgetParts(parts, 10),
  );
});

test("filters empty outputs before pairing and aligns an odd final child left", () => {
  const parts = [
    { id: "empty", priority: 0, text: "" },
    { id: "ansi-only", priority: 1, text: "\x1b[33m\x1b[39m" },
    ...["A", "B", "C", "D", "E"].map((text, priority) => ({
      id: text,
      text,
      priority: priority + 2,
    })),
  ];
  assert.deepEqual(layoutWidgetParts(parts, 6), ["A    B", "C    D", "E"]);
  assert.deepEqual(layoutWidgetParts(parts, 0), []);
  assert.deepEqual(layoutWidgetParts(parts, -1), []);
  assert.deepEqual(layoutWidgetParts([], 80), []);
});

test("wraps a complete pair before clipping either child at the exact boundary", () => {
  const parts = [
    { id: "a", priority: 0, text: "AAAA" },
    { id: "b", priority: 1, text: "BBBB" },
  ];
  assert.deepEqual(layoutWidgetParts(parts, 10), ["AAAA  BBBB"]);
  assert.deepEqual(layoutWidgetParts(parts, 9), ["AAAA", "BBBB"]);
  assert.deepEqual(layoutWidgetParts(parts, 4), ["AAAA", "BBBB"]);
  const narrow = layoutWidgetParts(parts, 3);
  assert.equal(narrow.length, 2);
  assert.ok(narrow.every((line) => visibleWidth(line) <= 3));
});

test("splits an overflowing pair into two left-aligned rows without repacking", () => {
  assert.deepEqual(
    layoutWidgetParts(
      [
        { id: "a", priority: 0, text: "AAAAAAAA" },
        { id: "b", priority: 1, text: "B" },
        { id: "c", priority: 2, text: "C" },
      ],
      9,
    ),
    ["AAAAAAAA", "B", "C"],
  );
});

test("clips only oversized single children and preserves fitting partners", () => {
  const parts = [
    { id: "long", priority: 0, text: "中文🙂".repeat(10) },
    { id: "short", priority: 1, text: "OK" },
  ];
  for (const width of [1, 2, 3, 6, 10, 20]) {
    const lines = layoutWidgetParts(parts, width);
    assert.equal(lines.length, 2);
    assert.ok(lines.every((line) => visibleWidth(line) <= width));
    if (width >= 2) assert.equal(lines[1], "OK");
  }
});

test("uses visible terminal columns when measuring colored Unicode children", () => {
  const parts = [
    { id: "a", priority: 0, text: "\x1b[33m中文\x1b[39m" },
    { id: "b", priority: 1, text: "🙂" },
  ];
  const wide = layoutWidgetParts(parts, 8);
  assert.equal(wide.length, 1);
  assert.equal(visibleWidth(wide[0]), 8);
  assert.equal(stripTerminalSequences(wide[0]), "中文  🙂");
  assert.deepEqual(layoutWidgetParts(parts, 7).map(stripTerminalSequences), [
    "中文",
    "🙂",
  ]);
});
