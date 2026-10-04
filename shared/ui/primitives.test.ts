import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { fillPanel, panelRule } from "./panel.ts";
import { layoutTabs, tabAt } from "./tabs.ts";

test("tabs accept arbitrary labels without questionnaire state", () => {
  const labels = ["Overview", "日志🙂", "Settings", "Done"];
  for (const width of [1, 2, 6, 7, 12, 40]) {
    for (let active = 0; active < labels.length; active++) {
      const tabs = layoutTabs(labels, active, width);
      assert.ok(tabs.some((tab) => tab.index === active));
      for (const tab of tabs) {
        assert.ok(tab.x + tab.width <= width);
        assert.equal(visibleWidth(tab.label), tab.width);
        if (tab.width > 0) {
          assert.equal(tabAt(tabs, tab.x, 0), tab.index);
        }
        assert.equal(tabAt(tabs, tab.x, 1), undefined);
      }
      assert.equal(tabAt(tabs, -1, 0), undefined);
      assert.equal(tabAt(tabs, width, 0), undefined);
    }
  }
  assert.deepEqual(layoutTabs([], 0, 80), []);
  assert.deepEqual(layoutTabs(labels, 0, 0), []);
  assert.ok(layoutTabs(labels, -1, 40).some((tab) => tab.index === 0));
  assert.ok(layoutTabs(labels, 99, 40).some((tab) => tab.index === 3));
});

test("tab viewport supports many labels, narrow widths and click bounds", () => {
  const labels = [
    ...Array.from({ length: 200 }, (_, index) => `[Item${index + 1}]`),
    "[Done]",
  ];
  for (const width of [0, 1, 2, 6, 7, 15, 40, 80]) {
    for (let active = 0; active <= 200; active++) {
      const tabs = layoutTabs(labels, active, width);
      if (width === 0) assert.deepEqual(tabs, []);
      else assert.ok(tabs.some((tab) => tab.index === active));
      for (const tab of tabs) {
        assert.ok(tab.x + tab.width <= width);
        assert.equal(tabAt(tabs, tab.x, 0), tab.index);
        assert.equal(tabAt(tabs, tab.x, 1), undefined);
        assert.equal(visibleWidth(tab.label), tab.width);
      }
      assert.equal(tabAt(tabs, -1, 0), undefined);
      assert.equal(tabAt(tabs, width, 0), undefined);
    }
  }
  const tabs = layoutTabs(labels, 100, 30);
  assert.equal(tabs[0].label, "‹");
  assert.equal(tabs.at(-1)?.label, "›");
});

test("panels clip Unicode content and pin arbitrary footer rows", () => {
  const lines = fillPanel(
    ["日志🙂".repeat(10), "Body", "Action", "Help"],
    8,
    6,
  );
  assert.equal(lines.length, 6);
  assert.ok(lines.every((line) => visibleWidth(line) === 8));
  assert.equal(lines[4].trim(), "Action");
  assert.equal(lines[5].trim(), "Help");
  assert.deepEqual(fillPanel(["Body"], 8, 0), []);
  assert.equal(visibleWidth(panelRule(8, "日志🙂", (text) => text)), 8);
  for (const width of [0, 1, 2, 7, 20, 80]) {
    const line = panelRule(width, "问题🙂 · Enter", (text) => text);
    assert.equal(visibleWidth(line), width);
  }
});
