import assert from "node:assert/strict";
import { test } from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  compactCall,
  compactMessage,
  compactResult,
  type ResultRenderer,
} from "./renderers.ts";

const theme = {
  fg: (_color: string, value: string) => value,
  bg: (_color: string, value: string) => value,
  bold: (value: string) => value,
} as Theme;
const context = (isError = false) =>
  ({ isError }) as Parameters<ResultRenderer>[3];
const result = Object.freeze({
  content: [
    Object.freeze({ type: "text" as const, text: "Full body\n  Second line" }),
  ],
  details: Object.freeze({ path: "/private/file", value: "metadata" }),
});

test("shared result rendering bounds previews and preserves full content and details", () => {
  const renderer = compactResult(() => ({
    status: "completed",
    preview: "中文🙂".repeat(2000),
  }));
  for (const width of [0, 1, 8, 80]) {
    const lines = renderer(
      result,
      { expanded: false, isPartial: false },
      theme,
      context(),
    ).render(width);
    assert.ok(lines.length <= 2);
    assert.ok(lines.every((line) => visibleWidth(line) <= width));
    assert.ok(!lines.join("\n").includes("/private/file"));
  }
  const full = renderer(
    result,
    { expanded: true, isPartial: false },
    theme,
    context(),
  )
    .render(200)
    .join("\n");
  assert.match(full, /Full body/);
  assert.ok(full.includes("  Second line"));
  assert.match(full, /\/private\/file/);
  assert.equal(result.content[0].text, "Full body\n  Second line");
});

test("shared renderers distinguish streaming and errors without claiming success", () => {
  const renderer = compactResult(() => undefined);
  for (const [isPartial, isError, status] of [
    [true, false, "running"],
    [false, true, "error"],
    [false, false, "result"],
  ] as const) {
    assert.equal(
      renderer(
        result,
        { expanded: false, isPartial },
        theme,
        context(isError),
      ).render(80)[0],
      status,
    );
  }
});

test("shared messages apply full-width background in both modes", () => {
  const message = compactMessage("Notification", () => ({
    status: "completed",
    preview: "中文🙂",
  }));
  const backgroundTheme = {
    ...theme,
    bg: (color: string, value: string) => {
      assert.equal(color, "customMessageBg");
      return `\x1b[45m${value}\x1b[49m`;
    },
  } as Theme;
  for (const expanded of [false, true]) {
    for (const width of [8, 80]) {
      const lines = message(
        {
          role: "custom",
          timestamp: 0,
          customType: "test",
          content: "Full message",
          details: { value: "metadata" },
          display: true,
        },
        { expanded, outputPad: 0 },
        backgroundTheme,
      )?.render(width);
      assert.ok(lines && lines.length > 0);
      assert.ok(lines.every((line) => line.includes("\x1b[45m")));
      assert.ok(lines.every((line) => visibleWidth(line) === width));
    }
  }
});

test("shared calls and messages escape terminal controls in both modes", () => {
  const args = { secret: "hidden\x1b[2J\x9b31m\u2028value" };
  const call = compactCall("Tool", () => args.secret);
  const message = compactMessage("Notification", () => ({
    status: "completed",
    preview: args.secret,
  }));
  for (const expanded of [false, true]) {
    const lines = [
      ...call(args, theme, { expanded } as Parameters<typeof call>[2]).render(
        80,
      ),
      ...(message(
        {
          role: "custom",
          timestamp: 0,
          customType: "test",
          content: "Full message",
          details: args,
          display: true,
        },
        { expanded, outputPad: 0 },
        theme,
      )?.render(80) ?? []),
    ].join("\n");
    for (const control of ["\x1b", "\x9b", "\u2028"])
      assert.ok(!lines.includes(control));
  }
});
