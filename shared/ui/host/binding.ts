import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { createPiDialogAdapter } from "../adapters/pi-dialog/index.ts";
import type { UIAdapter } from "../session/index.ts";
import { createUIHost } from "./host.ts";
import type { UIHost } from "./types.ts";

export interface UIHostBinding {
  hasUI: boolean;
  ui: Pick<ExtensionUIContext, "select" | "input">;
  signal?: AbortSignal;
}

// Share only the adapter/resource identity. Every binding has a fresh lifetime.
const adapters = new WeakMap<UIHostBinding["ui"], UIAdapter>();

/** Pi bootstrap boundary. Concrete frontend policy stays inside shared UI. */
export function bindUIHost(binding: UIHostBinding): UIHost {
  if (!binding.hasUI) throw new Error("UI unavailable for host binding.");
  let adapter = adapters.get(binding.ui);
  if (!adapter) {
    adapter = createPiDialogAdapter(binding.ui);
    adapters.set(binding.ui, adapter);
  }
  // Current generic fallback is sequential dialogs for both TUI and RPC.
  // Legacy custom TUI is still called separately until its adapter is migrated.
  return createUIHost(adapter, { signal: binding.signal });
}
