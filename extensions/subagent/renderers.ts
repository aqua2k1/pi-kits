import {
  compactCall,
  compactMessage,
  compactResult,
  type RenderSummary,
  record,
} from "../../shared/ui/renderers.ts";
import type { AgentSnapshot } from "./manager.ts";
import { agentDisplayStatus } from "./presentation.ts";

export const subagentCallRenderer = (label: string) =>
  compactCall(label, (args) => {
    const description = record(args).description;
    return typeof description === "string" ? description : "";
  });

function snapshotSummary(
  details: unknown,
  args?: unknown,
): RenderSummary | undefined {
  const data = record(details);
  if (typeof data.description !== "string" || typeof data.status !== "string")
    return;
  const snapshot = data as unknown as AgentSnapshot;
  const isError =
    snapshot.status === "error" ||
    snapshot.status === "disconnected" ||
    snapshot.sessionState === "disconnected";
  return {
    title:
      record(args).description === snapshot.description
        ? undefined
        : snapshot.description,
    status: agentDisplayStatus(snapshot),
    preview:
      typeof snapshot.error === "string"
        ? snapshot.error
        : typeof snapshot.result === "string"
          ? snapshot.result
          : "",
    isError,
    truncated: snapshot.truncated,
  };
}

export const renderSubagentResult = compactResult(snapshotSummary);
export const renderSubagentNotification = compactMessage(
  "Subagent",
  snapshotSummary,
);
export const renderSubagentTypesCall = compactCall("Subagent types");
export const renderSubagentTypesResult = compactResult((details) => {
  const agents = record(details).agents;
  if (!Array.isArray(agents)) return;
  return {
    status: `${agents.length} types`,
    preview: agents
      .map((agent) => {
        const entry = record(agent);
        return `${entry.displayName ?? entry.name ?? "Agent"}${entry.enabled === false ? " (disabled)" : ""}`;
      })
      .join(" · "),
  };
});
