import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import {
  type CallRenderer,
  compactMessage,
  compactResult,
  jsonText,
  type RenderSummary,
  type ResultRenderer,
  record,
} from "../../../shared/ui/renderers.ts";
import { type AgentSnapshot, hasDisplayError } from "../manager.ts";
import { agentHeader } from "./presentation.ts";

export const subagentCallRenderer =
  (
    label: string,
    lookup?: (id: string) => AgentSnapshot | undefined,
  ): CallRenderer =>
  (args, theme, context) => {
    if (context.expanded) return new Text(`${label}\n${jsonText(args)}`, 0, 0);
    const data = record(args);
    const id = typeof data.id === "string" ? data.id : "";
    const existing = id ? lookup?.(id) : undefined;
    const state = record(context.state);
    const snapshot: AgentSnapshot = existing ??
      (state.subagentSnapshot as AgentSnapshot | undefined) ?? {
        id,
        description:
          typeof data.description === "string"
            ? data.description
            : typeof data.action === "string"
              ? `${label} (${data.action})`
              : typeof data.prompt === "string" && data.prompt.trim()
                ? data.prompt.trim().split(/\r?\n/)[0].slice(0, 80)
                : label,
        subagentType: typeof data.agent === "string" ? data.agent : undefined,
        status: context.executionStarted ? "running" : "queued",
      };
    return {
      // Pi renders the call before the result. Read shared state at render
      // time so the result can own the header without a re-entrant invalidate.
      render: (width) =>
        width > 0 && !record(context.state).subagentSnapshot
          ? [truncateToWidth(agentHeader(snapshot, theme), width)]
          : [],
      invalidate() {},
    };
  };

function snapshotSummary(
  details: unknown,
  header: (snapshot: AgentSnapshot) => string,
): RenderSummary | undefined {
  const data = record(details);
  if (
    typeof data.description !== "string" ||
    typeof data.status !== "string" ||
    typeof data.id !== "string"
  )
    return;
  const snapshot = data as unknown as AgentSnapshot;
  return {
    status: header(snapshot),
    preview:
      typeof snapshot.error === "string"
        ? snapshot.error
        : typeof snapshot.result === "string" && snapshot.result
          ? snapshot.result
          : typeof snapshot.sessionActivity === "string"
            ? snapshot.sessionActivity
            : "",
    isError: hasDisplayError(snapshot),
    truncated: snapshot.truncated,
  };
}

export const renderSubagentResult: ResultRenderer = (
  result,
  options,
  theme,
  context,
) => {
  const details = record(result.details);
  if (
    typeof details.id === "string" &&
    typeof details.description === "string"
  ) {
    const state = record(context.state);
    if (state.subagentSnapshot !== result.details) {
      state.subagentSnapshot = result.details;
      context.state = state;
    }
  }
  return compactResult((data) =>
    snapshotSummary(data, (snapshot) => agentHeader(snapshot, theme)),
  )(result, options, theme, context);
};

export const renderSubagentNotification: ReturnType<typeof compactMessage> = (
  message,
  options,
  theme,
) =>
  compactMessage("", (details) => {
    const update = record(record(details).sessionUpdate);
    const summary = snapshotSummary(
      details,
      (snapshot) =>
        `${agentHeader(snapshot, theme)}${update.interactionId ? ` · user interaction ${update.outcome} · reply #${snapshot.resultRevision ?? 0}` : ""}`,
    );
    if (summary && update.interactionId) {
      summary.isError = update.outcome === "error";
      summary.preview =
        typeof update.error === "string"
          ? update.error
          : update.hasReply === false
            ? "No new reply; previous result retained"
            : typeof record(details).result === "string"
              ? String(record(details).result)
              : "No new reply";
    }
    return summary;
  })(message, options, theme);
