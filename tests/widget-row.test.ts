import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import providerUsage from "../extensions/provider-usage/index.ts";
import tokenMeter from "../extensions/token-meter/index.ts";
import { useAgentDir } from "./helpers/agent-dir.ts";

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
type Widget = Parameters<ExtensionContext["ui"]["setWidget"]>[1];

test("provider usage and token meter share one widget and release only their side", async (t) => {
  useAgentDir(t);
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({
      is_available: true,
      balance_infos: [{ currency: "CNY", total_balance: "110.00" }],
    }),
  );
  const events = new Map<string, Handler[]>();
  const widgets = new Map<string, Widget | string[]>();
  const pi = {
    on(name: string, handler: Handler) {
      events.set(name, [...(events.get(name) ?? []), handler]);
    },
    registerCommand() {},
  } as unknown as ExtensionAPI;
  const ctx = {
    mode: "tui",
    model: { provider: "deepseek" },
    ui: {
      setWidget(id: string, widget: Widget | string[]) {
        if (widget === undefined) widgets.delete(id);
        else widgets.set(id, widget);
      },
    },
    modelRegistry: { getApiKeyForProvider: async () => "fixture-token" },
  } as unknown as ExtensionContext;
  let time = 0;
  providerUsage(pi);
  tokenMeter(pi, () => time);
  async function emit(name: string, event = {}) {
    for (const handler of events.get(name) ?? []) {
      await handler({ type: name, ...event }, ctx);
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  t.after(() => emit("session_shutdown"));
  function text() {
    assert.equal(widgets.size, 1);
    const widget = [...widgets.values()][0];
    assert.equal(typeof widget, "function");
    if (typeof widget !== "function")
      throw new Error("Expected widget factory");
    const component = widget(
      { requestRender() {} } as Parameters<typeof widget>[0],
      { fg: (_tone: string, text: string) => text } as Parameters<
        typeof widget
      >[1],
    );
    const line = component.render(100)[0];
    assert.equal(visibleWidth(line), 100);
    return stripTerminalSequences(line);
  }

  await emit("session_start");
  assert.ok(text().startsWith("DeepSeek"));
  assert.ok(text().endsWith("TTFT — · TPS —"));
  await emit("turn_start");
  await emit("before_provider_request");
  await emit("message_start", { message: { role: "assistant" } });
  time = 800;
  await emit("message_update", {
    message: { role: "assistant" },
    assistantMessageEvent: { type: "text_delta", delta: "Hello" },
  });
  time = 5000;
  await emit("message_end", {
    message: { role: "assistant", stopReason: "stop", usage: { output: 315 } },
  });
  assert.ok(text().startsWith("DeepSeek"));
  assert.ok(text().endsWith("TTFT 0.8s · TPS 63 token/s"));
  await emit("model_select", { model: { provider: "unsupported" } });
  assert.equal(text().trimStart(), "TTFT 0.8s · TPS 63 token/s");
  await emit("session_shutdown");
  assert.equal(widgets.size, 0);
});
