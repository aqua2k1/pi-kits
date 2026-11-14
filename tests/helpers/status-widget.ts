import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { acquireWidgetPart } from "@pi-kits/shared/ui/widget";

export default function statusWidget(pi: ExtensionAPI) {
  let part: ReturnType<typeof acquireWidgetPart> | undefined;
  function update(ctx: ExtensionContext, provider = ctx.model?.provider) {
    part ??= acquireWidgetPart(ctx.ui, "fixture-status", 10);
    part.update(provider === "fixture" ? "Fixture status" : "");
  }
  pi.on("session_start", (_event, ctx) => update(ctx));
  pi.on("model_select", (event, ctx) => update(ctx, event.model.provider));
  pi.on("session_shutdown", () => {
    part?.dispose();
    part = undefined;
  });
}
