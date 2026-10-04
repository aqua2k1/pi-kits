import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readPiKitsConfig } from "@pi-kits/config";
import { notify } from "../../shared/notifications/index.ts";

export const NOTIFICATION_QUIET_PERIOD_MS = 1_000;

export interface CompletionNotificationDependencies {
  notify(title: string, msg: string): unknown | Promise<unknown>;
  schedule(callback: () => void, delayMs: number): () => void;
}

const defaultDependencies: CompletionNotificationDependencies = {
  notify: (title, msg) => notify(title, msg),
  schedule(callback, delayMs) {
    const timer = setTimeout(callback, delayMs);
    return () => clearTimeout(timer);
  },
};

export function registerCompletionNotification(
  pi: ExtensionAPI,
  dependencies: CompletionNotificationDependencies = defaultDependencies,
  quietPeriodMs = NOTIFICATION_QUIET_PERIOD_MS,
): void {
  let cancelPendingNotification: (() => void) | undefined;

  const cancelPending = (): void => {
    cancelPendingNotification?.();
    cancelPendingNotification = undefined;
  };

  // A later-loaded extension may start another run from its own settled handler.
  // Cancel the notification as soon as new input or a new run begins.
  pi.on("input", cancelPending);
  pi.on("before_agent_start", cancelPending);
  pi.on("agent_start", cancelPending);
  pi.on("session_shutdown", cancelPending);

  // `agent_settled` runs only after retries, compaction, and queued follow-ups.
  // The extension itself is active only in Pi's interactive TUI mode.
  pi.on("agent_settled", (_event, ctx) => {
    cancelPending();
    if (ctx.mode !== "tui") return;
    if (!ctx.isIdle()) return;

    // Give later settled handlers time to start or queue continuations before
    // the desktop notification is committed.
    let isPending = true;
    const cancelScheduled = dependencies.schedule(() => {
      isPending = false;
      cancelPendingNotification = undefined;
      if (ctx.mode !== "tui") return;
      if (!ctx.isIdle()) return;

      try {
        void Promise.resolve(
          dependencies.notify("Pi", "Task completed."),
        ).catch(() => undefined);
      } catch {
        // Notification delivery is best-effort and must never fail the task.
        return;
      }
    }, quietPeriodMs);
    cancelPendingNotification = isPending ? cancelScheduled : undefined;
  });
}

export default function notifyExtension(pi: ExtensionAPI): void {
  const { notify: config } = readPiKitsConfig();
  if (!config.enabled) return;
  registerCompletionNotification(pi, defaultDependencies, config.quietPeriodMs);
}
