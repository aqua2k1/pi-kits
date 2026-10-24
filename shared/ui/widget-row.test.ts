import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { acquireWidgetPart } from "./widget.ts";

const theme = {
  fg: (tone: string, text: string) =>
    `\x1b[${tone === "warning" ? 33 : 90}m${text}\x1b[39m`,
} as Theme;

function host() {
  let component: { render(width: number): string[] } | undefined;
  let mounts = 0;
  let renders = 0;
  let currentTheme = theme;
  const ui = {
    setWidget: ((_id, factory, options) => {
      if (factory === undefined) {
        component = undefined;
        return;
      }
      assert.equal(typeof factory, "function");
      if (typeof factory !== "function")
        throw new Error("Expected widget factory");
      assert.equal(options?.placement, "belowEditor");
      mounts++;
      component = factory(
        {
          requestRender() {
            renders++;
          },
        } as Parameters<typeof factory>[0],
        {
          fg: (tone: Parameters<Theme["fg"]>[0], text: string) =>
            currentTheme.fg(tone, text),
        } as Theme,
      );
    }) as ExtensionContext["ui"]["setWidget"],
  };
  return {
    ui,
    get component() {
      return component;
    },
    get mounts() {
      return mounts;
    },
    get renders() {
      return renders;
    },
    render(width = 80) {
      return component?.render(width) ?? [];
    },
    text(width = 80) {
      return stripTerminalSequences(component?.render(width)[0] ?? "");
    },
    setTheme(value: Theme) {
      currentTheme = value;
    },
  };
}

for (const first of ["provider-usage", "token-meter"] as const) {
  test(`independent children share one parent when ${first} attaches first`, () => {
    const h = host();
    const second =
      first === "provider-usage" ? "token-meter" : "provider-usage";
    const children = {
      [first]: acquireWidgetPart(h.ui, first),
      [second]: acquireWidgetPart(h.ui, second),
    };
    const usage = children["provider-usage"];
    const tokens = children["token-meter"];
    usage.update("ChatGPT 24%", "warning");
    const parent = h.component;
    tokens.update("TTFT 0.8s · TPS 63 token/s");
    assert.equal(h.component, parent);
    assert.equal(h.mounts, 1);
    assert.equal(h.renders, 1);
    assert.equal(visibleWidth(h.render()[0]), 80);
    assert.ok(h.text().startsWith("ChatGPT 24%"));
    assert.ok(h.text().endsWith("TTFT 0.8s · TPS 63 token/s"));
    assert.ok(h.render()[0].includes("\x1b[33m"));

    usage.update("DeepSeek 110 CNY");
    assert.ok(h.text().endsWith("TTFT 0.8s · TPS 63 token/s"));
    tokens.update("TTFT 1.0s · TPS 80 token/s");
    assert.ok(h.text().startsWith("DeepSeek 110 CNY"));
    assert.equal(h.mounts, 1);
    usage.update("");
    assert.equal(h.text().trimStart(), "TTFT 1.0s · TPS 80 token/s");
    usage.dispose();
    assert.equal(h.component, parent);
    tokens.dispose();
    assert.equal(h.component, undefined);
  });
}

test("empty strings hide children without destroying their ownership", () => {
  const h = host();
  const usage = acquireWidgetPart(h.ui, "provider-usage");
  const tokens = acquireWidgetPart(h.ui, "token-meter");
  usage.update("");
  tokens.update("");
  assert.deepEqual(h.render(), []);
  usage.update("balance");
  assert.equal(h.text(), "balance");
  tokens.dispose();
  tokens.dispose();
  assert.equal(h.text(), "balance");
  usage.dispose();
  assert.equal(h.component, undefined);
});

test("released or replaced writers cannot change the current children", () => {
  const h = host();
  const old = acquireWidgetPart(h.ui, "token-meter");
  old.update("old");
  const current = acquireWidgetPart(h.ui, "token-meter");
  current.update("current");
  old.update("stale");
  old.dispose();
  assert.equal(h.text().trimStart(), "current");
  current.dispose();
  current.update("after release");
  assert.equal(h.component, undefined);
  const replacement = acquireWidgetPart(h.ui, "token-meter");
  replacement.update("new session");
  old.dispose();
  current.dispose();
  assert.equal(h.text().trimStart(), "new session");
  replacement.dispose();
});

test("the parent lays out read-only child output safely across widths and themes", () => {
  const h = host();
  const usage = acquireWidgetPart(h.ui, "provider-usage");
  const tokens = acquireWidgetPart(h.ui, "token-meter");
  const right = "TTFT 0.8s · TPS 63 token/s";
  usage.update("余额中文🙂".repeat(30));
  tokens.update(right);
  for (const width of [0, 1, 2, 10, 24, 25, 30, 80, 120]) {
    const lines = h.render(width);
    assert.equal(lines.length, width === 0 ? 0 : 1);
    if (!width) continue;
    assert.ok(visibleWidth(lines[0]) <= width);
    if (width >= visibleWidth(right)) assert.ok(h.text(width).endsWith(right));
  }
  tokens.update("");
  usage.update("balance\n\x1b]52;c;payload\x07next");
  assert.equal(h.text(), "balance next");
  h.setTheme({ fg: (_tone: string, text: string) => `new:${text}` } as Theme);
  assert.equal(h.text(), "new:balance next");
  usage.dispose();
  tokens.dispose();
});

test("different UI contexts have independent parent widgets", () => {
  const first = host();
  const second = host();
  const usage = acquireWidgetPart(first.ui, "provider-usage");
  const tokens = acquireWidgetPart(second.ui, "token-meter");
  usage.update("first");
  tokens.update("second");
  assert.equal(first.text(), "first");
  assert.equal(second.text().trimStart(), "second");
  usage.dispose();
  assert.equal(second.text().trimStart(), "second");
  tokens.dispose();
});
