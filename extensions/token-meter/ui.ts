import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { setWidgetRow } from "@pi-kits/shared/ui/widget";

export function formatTokenMeter(ttftMs?: number, tps?: number): string {
  const ttft = ttftMs === undefined ? "—" : `${(ttftMs / 1000).toFixed(1)}s`;
  const speed = tps === undefined ? "—" : `${Math.round(tps)} token/s`;
  return `TTFT ${ttft} · TPS ${speed}`;
}

export function updateTokenMeterUi(ctx: ExtensionContext, text: string): void {
  if (ctx.mode !== "tui") return;
  setWidgetRow(ctx.ui, "token-meter", text);
}
