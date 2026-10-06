import assert from "node:assert/strict";
import { test } from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import {
  renderTree,
  TREE_BRANCH_MARKER,
  TREE_CONTINUATION_MARKER,
  TREE_DETAIL_MARKER,
  TREE_INDENT_WIDTH,
  TREE_LAST_BRANCH_MARKER,
  type TreeNode,
} from "./tree.ts";
import { renderWidgetFrame } from "./widget.ts";

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as Theme;

const nested: TreeNode<string>[] = [
  {
    content: "First",
    data: "first",
    children: [
      { content: "Child A", children: [{ content: "Grandchild" }] },
      { content: "Child B", data: "child-b" },
    ],
  },
  { content: "Last", children: [{ content: "Final child" }] },
];

test("tree markers and indentation are defined by the shared renderer", () => {
  assert.deepEqual(
    [
      TREE_BRANCH_MARKER,
      TREE_LAST_BRANCH_MARKER,
      TREE_CONTINUATION_MARKER,
      TREE_DETAIL_MARKER,
    ],
    ["├─", "└─", "│", "⎿"],
  );
  assert.equal(TREE_INDENT_WIDTH, 4);
});

test("trees support flat lists without a widget and close the final branch", () => {
  assert.deepEqual(
    renderTree([{ content: "A" }, { content: "B" }], theme, 80).map(
      (row) => row.text,
    ),
    ["├─ A", "└─ B"],
  );
  assert.deepEqual(renderTree([{ content: "Only" }], theme, 80), [
    { text: "└─ Only", depth: 0, data: undefined },
  ]);
  assert.deepEqual(renderTree([], theme, 80), []);
  assert.deepEqual(renderTree(nested, theme, 0), []);
});

test("nested branches preserve ancestor continuations and stop below last siblings", () => {
  const rows = renderTree(nested, theme, 80);
  assert.deepEqual(
    rows.map((row) => row.text),
    [
      "├─ First",
      "│   ├─ Child A",
      "│   │   └─ Grandchild",
      "│   └─ Child B",
      "└─ Last",
      "    └─ Final child",
    ],
  );
  assert.deepEqual(
    rows.map((row) => row.depth),
    [0, 1, 2, 1, 0, 1],
  );
  assert.deepEqual(
    rows.map((row) => row.data),
    ["first", undefined, undefined, "child-b", undefined, undefined],
  );
});

test("custom detail markers retain the same ancestry and do not inherit action data", () => {
  const data = { id: "agent" };
  const rows = renderTree(
    [
      {
        content: "Agent",
        data,
        children: [{ content: "Activity", marker: TREE_DETAIL_MARKER }],
      },
    ],
    theme,
    80,
  );
  assert.deepEqual(
    rows.map((row) => row.text),
    ["└─ Agent", "    ⎿ Activity"],
  );
  assert.equal(rows[0].data, data);
  assert.equal(rows[1].data, undefined);
});

test("trees theme only connectors and clip Unicode and ANSI content at narrow widths", () => {
  const colors: { color: string; text: string }[] = [];
  const colored = {
    ...theme,
    fg(color: string, text: string) {
      colors.push({ color, text });
      return `\x1b[90m${text}\x1b[39m`;
    },
  } as Theme;
  const nodes = [{ content: "\x1b[32m中文🙂标题\x1b[39m", children: nested }];
  for (const width of [1, 2, 4, 8, 24, 80]) {
    const rows = renderTree(nodes, colored, width);
    assert.equal(rows.length, 7);
    assert.ok(rows.every((row) => visibleWidth(row.text) <= width));
  }
  assert.ok(colors.every(({ color }) => color === "muted"));
  const rows = renderTree(nodes, colored, 80);
  assert.ok(rows[0].text.includes("\x1b[32m"));
  assert.equal(stripTerminalSequences(rows[0].text), "└─ 中文🙂标题");
});

test("tree output composes with widget frames but frame content need not be a tree", () => {
  const framed = renderWidgetFrame("Tree", theme, 40, (width) =>
    renderTree(nested, theme, width).map((row) => row.text),
  );
  assert.equal(framed.length, 8);
  assert.ok(framed.every((line) => visibleWidth(line) === 40));
  assert.match(framed[6], /^│ {5}└─ Final child/);
  const plain = renderWidgetFrame("Plain", theme, 40, () => ["No branches"]);
  assert.ok(!plain.join("").includes("├─"));
  assert.match(plain[1], /^│ No branches/);
});
