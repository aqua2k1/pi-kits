import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { formatTokenMeter, updateTokenMeterUi } from "./ui.ts";

type Widget = Parameters<ExtensionContext["ui"]["setWidget"]>[1];

test("UI formats seconds, rounded TPS and placeholders, then clears its widget", () => {
  let widget: Widget | string[];
  const ctx = {
    mode: "tui",
    ui: {
      setWidget(_id: string, value: Widget | string[]) {
        widget = value;
      },
    },
  } as unknown as ExtensionContext;
  function text() {
    assert.equal(typeof widget, "function");
    if (typeof widget !== "function")
      throw new Error("Expected widget factory");
    return widget(
      { requestRender() {} } as Parameters<typeof widget>[0],
      { fg: (_tone: string, text: string) => text } as Parameters<
        typeof widget
      >[1],
    )
      .render(80)[0]
      .trimStart();
  }
  updateTokenMeterUi(ctx, formatTokenMeter());
  assert.equal(text(), "TTFT — · TPS —");
  updateTokenMeterUi(ctx, formatTokenMeter(849, 62.6));
  assert.equal(text(), "TTFT 0.8s · TPS 63 token/s");
  updateTokenMeterUi(ctx, formatTokenMeter(0));
  assert.equal(text(), "TTFT 0.0s · TPS —");
  updateTokenMeterUi(ctx, "");
  assert.equal(widget, undefined);
});
