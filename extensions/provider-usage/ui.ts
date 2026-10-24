import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { setWidgetRow } from "@pi-kits/shared/ui/widget";

export function updateProviderUsageUi(
  ui: ExtensionContext["ui"],
  text: string,
  isWarning = false,
): void {
  setWidgetRow(ui, "provider-usage", text, isWarning ? "warning" : "dim");
}
