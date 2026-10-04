import type {
  ExtensionUIContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import type {
  Component,
  KeybindingsManager,
  TUI,
} from "@earendil-works/pi-tui";
import type { DockedPanelCloseStatus, DockedPanelLifecycle } from "./events.ts";

export interface DockedPanelComponent extends Component {
  cancel(): void;
  dispose(): void;
}

/** One non-overlay editor interaction. Pi owns terminal routing and restoration. */
export async function runDockedPanel<T>(
  ui: Pick<ExtensionUIContext, "custom">,
  create: (
    tui: TUI,
    theme: Theme,
    keys: KeybindingsManager,
    done: (result: T) => void,
  ) => DockedPanelComponent,
  options: {
    signal?: AbortSignal;
    lifecycle?: DockedPanelLifecycle;
    isCancelled?: (result: T) => boolean;
  } = {},
): Promise<T> {
  const { signal, lifecycle } = options;
  signal?.throwIfAborted();
  let component: DockedPanelComponent | undefined;
  let opened = false;
  let disposed = false;
  let failed = false;
  let failure: unknown;
  let cleanupFailed = false;
  let cleanupError: unknown;
  let result!: T;
  let status: DockedPanelCloseStatus = "error";
  let finishHost: (() => void) | undefined;
  const rememberFailure = (error: unknown) => {
    if (failed) return;
    failed = true;
    failure = error;
  };
  const abort = () => {
    if (!component) return;
    try {
      component.cancel();
    } catch (error) {
      rememberFailure(error);
      // Complete through Pi, rather than racing a rejection against a mounted
      // UI. This error-only sentinel never reaches the caller or classifier.
      try {
        finishHost?.();
      } catch (settlementError) {
        rememberFailure(settlementError);
      }
    }
  };
  try {
    result = await ui.custom<T>((tui, theme, keys, done) => {
      finishHost = () => done(undefined as T);
      component = create(tui, theme, keys, done);
      const dispose = component.dispose.bind(component);
      // Both Pi and our finally may dispose. Run component cleanup just once,
      // retaining errors even when the host deliberately swallows them.
      component.dispose = () => {
        if (disposed) return;
        disposed = true;
        try {
          dispose();
        } catch (error) {
          cleanupFailed = true;
          cleanupError = error;
        }
      };
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) {
        abort();
      } else {
        opened = true;
        lifecycle?.onOpen?.();
      }
      return component;
    });
    if (!failed) {
      signal?.throwIfAborted();
      status = options.isCancelled?.(result) ? "cancelled" : "completed";
    }
  } catch (error) {
    rememberFailure(error);
  } finally {
    signal?.removeEventListener("abort", abort);
    component?.dispose();
    finishHost = undefined;
    if (cleanupFailed) rememberFailure(cleanupError);
    // Abort describes the interaction even if cancellation/disposal failed;
    // the rejection still retains the first error rather than the abort reason.
    status = signal?.aborted ? "aborted" : failed ? "error" : status;
    if (opened) {
      try {
        lifecycle?.onClosed?.(status);
      } catch (error) {
        rememberFailure(error);
      }
    }
  }
  if (failed) throw failure;
  return result;
}
