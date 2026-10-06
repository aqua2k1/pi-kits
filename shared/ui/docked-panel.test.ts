import assert from "node:assert/strict";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, visibleWidth } from "@earendil-works/pi-tui";
import {
  DockedPanelFrame,
  dockedContentBudget,
  dockedContentWindow,
  dockedListBudget,
  dockedPanelLayout,
} from "./docked-panel/index.ts";
import { layoutTabs } from "./tabs.ts";

const theme = {
  fg: (color: string, text: string) =>
    `\x1b[${color === "accent" ? 36 : 90}m${text}\x1b[0m`,
  bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
  underline: (text: string) => `\x1b[4m${text}\x1b[24m`,
} as Theme;
const plain = stripVTControlCharacters;

test("dock layout fixes half-height, navigation/hint thresholds and pinning", () => {
  for (let terminalRows = 1; terminalRows <= 61; terminalRows++) {
    for (const controls of [1, 2]) {
      const layout = dockedPanelLayout(terminalRows, controls);
      assert.equal(layout.rows, Math.max(1, Math.floor(terminalRows / 2)));
      assert.equal(layout.showTabs, layout.rows >= 7);
      assert.equal(layout.showHints, layout.rows >= 9);
      assert.equal(layout.compact, layout.rows < 9);
      assert.equal(layout.pinnedLines, controls + (layout.showHints ? 2 : 1));
    }
  }
});

test("content and list budgeting keep detail and scroll-indicator space", () => {
  const layout = dockedPanelLayout(24);
  assert.deepEqual(dockedContentBudget(layout, 20, 20, 50), {
    titleHeight: 3,
    detailHeight: 1,
  });
  assert.deepEqual(dockedListBudget(layout, 6, 1, 50), {
    budget: 2,
    visible: 1,
  });
  assert.deepEqual(dockedListBudget(layout, 99, 20, 50), {
    budget: 0,
    visible: 1,
  });
  assert.equal(
    dockedContentBudget(dockedPanelLayout(36), 20, 20, 1).detailHeight,
    2,
  );
  assert.deepEqual(
    dockedContentWindow(["title"], ["one", "two", "three"], 1, 1, 99),
    {
      offset: 2,
      scrollable: true,
      title: ["title"],
      detail: ["  three"],
    },
  );
  assert.deepEqual(dockedContentWindow(["title"], [], 1, 0, 10), {
    offset: 0,
    scrollable: false,
    title: ["title"],
    detail: [],
  });
});

test("shared frame themes boundaries, keeps tabs at y1, and fills Unicode cells", () => {
  for (const height of [1, 2, 3, 4, 6, 7, 8, 9, 12, 30]) {
    for (const width of [1, 2, 7, 15, 80]) {
      const layout = dockedPanelLayout(height * 2);
      const frame = new DockedPanelFrame(layout, width, theme, "Dock 🙂");
      const tabs = layoutTabs(["Overview", "日志🙂"], 1, width);
      const heading = frame.heading(tabs, 1);
      assert.equal(heading.length, height >= 7 ? 2 : 1);
      if (height >= 7) assert.ok(!plain(heading[1]).includes("─"));
      const lines = frame.finish(
        [
          ...heading,
          ...(height >= 3 ? ["body".repeat(50)] : []),
          `${CURSOR_MARKER}a`,
        ],
        "Shortcut",
      );
      assert.equal(lines.length, height);
      assert.ok(lines.every((line) => visibleWidth(line) === width));
      if (height >= 3) {
        assert.equal(lines.at(-1), theme.fg("accent", "─".repeat(width)));
        if (height >= 9 && width === 80)
          assert.equal(lines.at(-2)?.trimEnd(), theme.fg("muted", "Shortcut"));
      } else {
        assert.ok(lines.at(-1)?.startsWith("\x1b[4m"));
      }
      if (height >= 2)
        assert.ok(lines.some((line) => line.includes(CURSOR_MARKER)));
    }
  }
});

test("styled titles cannot reset the trailing boundary color", () => {
  const title = `${theme.fg("muted", "今日")} ${theme.fg("accent", theme.bold("40.6K"))}`;
  for (const width of [20, 40, 80, 120]) {
    const frame = new DockedPanelFrame(
      dockedPanelLayout(24),
      width,
      theme,
      title,
    );
    const line = frame.heading([], 0)[0];
    const trailing = "─".repeat(width - visibleWidth(`── ${title} `));
    assert.ok(line.endsWith(theme.fg("accent", theme.bold(trailing))));
    assert.equal(visibleWidth(line), width);
  }
});

test("compact frame prioritizes value/input and six-row title+detail+controls", () => {
  for (const height of [1, 2, 3, 4, 5, 6, 7, 8]) {
    for (const kind of ["value", "input", "controls"] as const) {
      const layout = dockedPanelLayout(height * 2, kind === "controls" ? 2 : 1);
      const frame = new DockedPanelFrame(layout, 40, theme, "Dock");
      const heading = frame.heading(layoutTabs(["Tab"], 0, 40), 0);
      const controls = ["Submit", "Cancel"];
      const content = [
        ...heading,
        ...frame.compactBody({
          progress: "Progress",
          title: ["Title"],
          detail: ["  Detail"],
          kind,
          active: () =>
            kind === "controls"
              ? height >= 4
                ? controls
                : [controls[0]]
              : [kind === "input" ? CURSOR_MARKER : "Value"],
        }),
      ];
      const lines = frame
        .finish(content)
        .map(plain)
        .map((line) => line.trimEnd());
      assert.equal(lines.length, height);
      if (kind === "controls" && height === 6)
        assert.deepEqual(lines, [
          `── Dock ${"─".repeat(32)}`,
          "Title",
          "  Detail",
          "Submit",
          "Cancel",
          "─".repeat(40),
        ]);
      if (kind === "controls" && height >= 4) {
        assert.deepEqual(frame.controlBounds(controls, content.length), [
          { index: 0, y: height - 3, width: 6 },
          { index: 1, y: height - 2, width: 6 },
        ]);
      }
      if (kind === "controls" && height < 4)
        assert.deepEqual(frame.controlBounds(controls, content.length), []);
    }
  }
});

test("expanded frame pins controls above separate muted shortcuts", () => {
  const frame = new DockedPanelFrame(
    dockedPanelLayout(24, 2),
    80,
    theme,
    "Dock",
  );
  const controls = ["Submit", "Cancel"];
  const content = [...frame.heading([], 0), "Title", ...controls];
  const lines = frame.finish(content, "Shortcut");
  assert.deepEqual(
    frame.controlBounds(controls, content.length).map((rect) => rect.y),
    [8, 9],
  );
  assert.equal(plain(lines[8]).trim(), "Submit");
  assert.equal(plain(lines[9]).trim(), "Cancel");
  assert.equal(plain(lines[10]).trim(), "Shortcut");
  assert.equal(plain(lines[11]), "─".repeat(80));
});
