import assert from "node:assert/strict";
import { test } from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { renderWidgetFrame } from "./widget.ts";

const theme = {
  fg: (color: string, text: string) =>
    `\x1b[${color === "accent" ? 33 : 90}m${text}\x1b[39m`,
  bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
} as Theme;

test("widget frames reserve padding and fit ANSI/Unicode content at all widths", () => {
  for (const width of [1, 4, 10, 23, 24, 40, 80, 200]) {
    let receivedWidth = 0;
    const lines = renderWidgetFrame(
      "日志🙂".repeat(20),
      theme,
      width,
      (inner) => {
        receivedWidth = inner;
        return [theme.fg("accent", "中文🙂".repeat(50)), ""];
      },
    );
    assert.equal(receivedWidth, width >= 24 ? width - 4 : width);
    assert.ok(lines.every((line) => visibleWidth(line) <= width));
    assert.equal(lines.length, width >= 24 ? 4 : 3);
    if (width >= 24) {
      assert.ok(lines.every((line) => visibleWidth(line) === width));
      assert.match(stripTerminalSequences(lines[0]), /^╭─ .*╮$/);
      assert.match(stripTerminalSequences(lines[1]), /^│ .* │$/);
      assert.equal(
        stripTerminalSequences(lines[2]),
        `│${" ".repeat(width - 2)}│`,
      );
      assert.equal(
        stripTerminalSequences(lines[3]),
        `╰${"─".repeat(width - 2)}╯`,
      );
    }
  }
});

test("widget frames omit empty content and zero widths and sanitize titles", () => {
  assert.deepEqual(
    renderWidgetFrame("Title", theme, 80, () => []),
    [],
  );
  assert.deepEqual(
    renderWidgetFrame("Title", theme, 0, () => {
      assert.fail("zero width must not render content");
    }),
    [],
  );
  const lines = renderWidgetFrame(
    "\x1b]52;c;payload\x07Title\n🙂",
    theme,
    40,
    () => ["Body"],
  );
  assert.match(stripTerminalSequences(lines[0]), /^╭─ Title 🙂 /);
  assert.ok(!lines.join("").includes("payload"));
});
