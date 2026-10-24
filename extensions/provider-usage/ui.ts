import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { acquireWidgetPart, type WidgetPart } from "@pi-kits/shared/ui/widget";

const parts = new WeakMap<ExtensionContext["ui"], WidgetPart>();

export function updateProviderUsageUi(
  ui: ExtensionContext["ui"],
  text: string,
  isWarning = false,
): void {
  if (text === "") {
    parts.get(ui)?.dispose();
    parts.delete(ui);
    return;
  }
  const part = parts.get(ui) ?? acquireWidgetPart(ui, "provider-usage", 10);
  parts.set(ui, part);
  part.update(text, isWarning ? "warning" : "dim");
}
