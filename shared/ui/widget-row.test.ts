import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { setWidgetRow } from "./widget.ts";

type Widget = Parameters<ExtensionContext["ui"]["setWidget"]>[1];
const theme = {
  fg: (tone: string, text: string) =>
    `\x1b[${tone === "warning" ? 33 : 90}m${text}\x1b[39m`,
} as Theme;

function host() {
  let widget: Widget | string[];
  const ids: string[] = [];
  const ui = {
    setWidget: ((id, value, options) => {
      ids.push(id);
      if (value !== undefined) assert.equal(options?.placement, "belowEditor");
      widget = value;
    }) as ExtensionContext["ui"]["setWidget"],
  };
  return {
    ui,
    ids,
    render(width: number, currentTheme = theme) {
      if (typeof widget !== "function") return [];
      return widget({} as Parameters<typeof widget>[0], currentTheme).render(
        width,
      );
    },
  };
}

for (const first of ["provider-usage", "token-meter"] as const) {
  test(`shared row composes both sides when ${first} registers first`, () => {
    const h = host();
    const values = {
      "provider-usage": "ChatGPT 24%",
      "token-meter": "TTFT 0.8s · TPS 63 token/s",
    };
    const second =
      first === "provider-usage" ? "token-meter" : "provider-usage";
    setWidgetRow(
      h.ui,
      first,
      values[first],
      first === "provider-usage" ? "warning" : "dim",
    );
    setWidgetRow(
      h.ui,
      second,
      values[second],
      second === "provider-usage" ? "warning" : "dim",
    );
    const line = h.render(80)[0];
    assert.equal(visibleWidth(line), 80);
    const plain = stripTerminalSequences(line);
    assert.ok(plain.startsWith(values["provider-usage"]));
    assert.ok(plain.endsWith(values["token-meter"]));
    assert.ok(line.includes("\x1b[33m"));
    assert.equal(new Set(h.ids).size, 1);

    setWidgetRow(h.ui, "provider-usage", "DeepSeek 110 CNY");
    assert.ok(
      stripTerminalSequences(h.render(80)[0]).endsWith(values["token-meter"]),
    );
    setWidgetRow(h.ui, "provider-usage", "");
    assert.equal(
      stripTerminalSequences(h.render(80)[0]).trimStart(),
      values["token-meter"],
    );
    setWidgetRow(h.ui, "token-meter", "");
    assert.deepEqual(h.render(80), []);
  });
}

test("clearing right preserves left and repeated cleanup is harmless", () => {
  const h = host();
  setWidgetRow(h.ui, "provider-usage", "");
  assert.equal(h.ids.length, 0);
  setWidgetRow(h.ui, "provider-usage", "balance");
  setWidgetRow(h.ui, "token-meter", "tokens");
  setWidgetRow(h.ui, "token-meter", "");
  assert.equal(stripTerminalSequences(h.render(80)[0]), "balance");
  setWidgetRow(h.ui, "provider-usage", "");
  const updates = h.ids.length;
  setWidgetRow(h.ui, "token-meter", "");
  assert.equal(h.ids.length, updates);
});

test("right side has priority and ANSI/Unicode content fits resizing terminals", () => {
  const h = host();
  const right = "TTFT 0.8s · TPS 63 token/s";
  setWidgetRow(h.ui, "provider-usage", "余额中文🙂".repeat(30));
  setWidgetRow(h.ui, "token-meter", right);
  for (const width of [0, 1, 2, 10, 24, 25, 30, 80, 120]) {
    const lines = h.render(width);
    assert.equal(lines.length, width === 0 ? 0 : 1);
    if (width === 0) continue;
    assert.ok(visibleWidth(lines[0]) <= width);
    if (width >= visibleWidth(right)) {
      assert.ok(stripTerminalSequences(lines[0]).endsWith(right));
    }
  }
});

test("theme colors are resolved at render time and text stays on one line", () => {
  const h = host();
  setWidgetRow(h.ui, "provider-usage", "balance\n\x1b]52;c;payload\x07next");
  assert.equal(stripTerminalSequences(h.render(80)[0]), "balance next");
  const otherTheme = {
    fg: (_tone: string, text: string) => `new:${text}`,
  } as Theme;
  assert.equal(h.render(80, otherTheme)[0], "new:balance next");
});

test("separate UI contexts never share row data", () => {
  const first = host();
  const second = host();
  setWidgetRow(first.ui, "provider-usage", "first");
  setWidgetRow(second.ui, "token-meter", "second");
  assert.equal(stripTerminalSequences(first.render(40)[0]), "first");
  assert.equal(
    stripTerminalSequences(second.render(40)[0]).trimStart(),
    "second",
  );
  setWidgetRow(first.ui, "provider-usage", "");
  assert.ok(stripTerminalSequences(second.render(40)[0]).endsWith("second"));
});
