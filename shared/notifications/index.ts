import { sendNotification } from "./core.ts";

/**
 * Open a native desktop notification without loading a Pi extension.
 * Delivery is best-effort; importing this module does not register hooks,
 * start processes, or schedule timers.
 */
export function notify(title: string, msg: string): boolean {
  return sendNotification(title, msg);
}
