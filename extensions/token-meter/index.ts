import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  calculateMetrics,
  createMeasurement,
  type Measurement,
  recordText,
  startMessage,
  startRequest,
} from "./meter.ts";
import { formatTokenMeter, updateTokenMeterUi } from "./ui.ts";

/** Clock injection keeps event-driven measurements deterministic in tests. */
export default function tokenMeter(
  pi: ExtensionAPI,
  now: () => number = () => performance.now(),
): void {
  let measurement: Measurement | undefined;

  function reset() {
    measurement = undefined;
  }

  pi.on("session_start", (_event, ctx) => {
    reset();
    updateTokenMeterUi(ctx, formatTokenMeter());
  });

  pi.on("session_shutdown", (_event, ctx) => {
    reset();
    updateTokenMeterUi(ctx, "");
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
    updateTokenMeterUi(ctx, formatTokenMeter(metrics.ttftMs, metrics.tps));
    reset();
  });

  pi.on("turn_end", reset);
  pi.on("agent_settled", reset);
}
