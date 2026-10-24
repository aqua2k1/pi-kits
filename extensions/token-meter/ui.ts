import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { acquireWidgetPart, type WidgetPart } from "@pi-kits/shared/ui/widget";

const parts = new WeakMap<ExtensionContext["ui"], WidgetPart>();

export function formatTokenMeter(ttftMs?: number, tps?: number): string {
  const ttft = ttftMs === undefined ? "—" : `${(ttftMs / 1000).toFixed(1)}s`;
  const speed = tps === undefined ? "—" : `${Math.round(tps)} token/s`;
  return `TTFT ${ttft} · TPS ${speed}`;
}

export function updateTokenMeterUi(ctx: ExtensionContext, text: string): void {
  if (ctx.mode !== "tui") return;
  if (text === "") {
    parts.get(ctx.ui)?.dispose();
    parts.delete(ctx.ui);
    return;
  }
  const part = parts.get(ctx.ui) ?? acquireWidgetPart(ctx.ui, "token-meter");
  parts.set(ctx.ui, part);
  part.update(text);
}
