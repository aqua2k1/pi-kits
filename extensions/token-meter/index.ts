import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  calculateMetrics,
  createMeasurement,
  formatStatus,
  type Measurement,
  recordText,
  startMessage,
  startRequest,
} from "./meter.ts";

const STATUS_ID = "token-meter";

/** Clock injection keeps event-driven measurements deterministic in tests. */
export default function tokenMeter(
  pi: ExtensionAPI,
  now: () => number = () => performance.now(),
): void {
  let measurement: Measurement | undefined;

  function reset() {
    measurement = undefined;
  }

  function setStatus(ctx: ExtensionContext, text: string | undefined) {
    if (ctx.mode === "tui") ctx.ui.setStatus(STATUS_ID, text);
  }

  pi.on("session_start", (_event, ctx) => {
    reset();
    setStatus(ctx, formatStatus());
  });

  pi.on("session_shutdown", (_event, ctx) => {
    reset();
    setStatus(ctx, undefined);
  });

  pi.on("turn_start", () => {
    measurement = createMeasurement();
  });

  pi.on("before_provider_request", () => {
    if (measurement) measurement = startRequest(measurement, now());
  });

  pi.on("message_start", (event) => {
    if (measurement && event.message.role === "assistant") {
      measurement = startMessage(measurement);
    }
  });

  pi.on("message_update", (event) => {
    const delta = event.assistantMessageEvent;
    if (
      measurement &&
      event.message.role === "assistant" &&
      delta.type === "text_delta"
    ) {
      measurement = recordText(measurement, delta.delta, now());
    }
  });

  pi.on("message_end", (event, ctx) => {
    if (!measurement || event.message.role !== "assistant") return;
    const metrics = calculateMetrics(measurement, event.message, now());
    setStatus(ctx, formatStatus(metrics));
    reset();
  });

  pi.on("turn_end", reset);
  pi.on("agent_settled", reset);
}
