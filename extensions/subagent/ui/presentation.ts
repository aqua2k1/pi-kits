import type { Theme } from "@earendil-works/pi-coding-agent";
import { oneLine } from "../../../shared/ui/renderers.ts";
import { renderTree, type TreeNode } from "../../../shared/ui/tree.ts";
import {
  renderWidgetFrame,
  widgetContentBounds,
} from "../../../shared/ui/widget.ts";
import type { AgentSnapshot, AgentStatus } from "../manager.ts";

export { oneLine } from "../../../shared/ui/renderers.ts";

export interface AgentSource {
  list(): AgentSnapshot[];
  subscribe(listener: () => void): () => void;
}

const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function isWorking(status: AgentStatus): boolean {
  return status === "starting" || status === "running" || status === "stopping";
}

export function isBusy(agent: AgentSnapshot): boolean {
  return isWorking(agent.status) || agent.sessionState === "interactive";
}

export function agentDisplayStatus(agent: AgentSnapshot): string {
  return agent.sessionState === "interactive" ||
    agent.sessionState === "disconnected" ||
    agent.sessionState === "closed"
    ? `${agent.status} · ${agent.sessionState}`
    : agent.status;
}

export function agentTitle(agent: AgentSnapshot): string {
  return oneLine(`${agentName(agent)} · ${agent.description}`);
}

export function agentName(agent: AgentSnapshot): string {
  const name = oneLine(agent.displayName || agent.subagentType || "Subagent");
  const runtime = oneLine(
    agent.runtimeName ||
      (agent.runtime
        ? agent.runtime[0].toUpperCase() + agent.runtime.slice(1)
        : ""),
  );
  return runtime ? `${name}(${runtime})` : name;
}

export function agentModel(agent: AgentSnapshot): string {
  return oneLine(agent.configuredModel || "—");
}

/** Shared identity/status row for widgets, tool cards and views. */
export function agentHeader(
  agent: AgentSnapshot,
  theme: Theme,
  now = Date.now(),
): string {
  return `${statusIcon(agent, theme, now)} ${agentName(agent)} · ${agentModel(agent)} · ${oneLine(agent.description)} · ${oneLine(agent.id.slice(0, 8)) || "—"} · ${oneLine(agentDisplayStatus(agent))}`;
}

export function duration(agent: AgentSnapshot, now = Date.now()): string {
  const start = agent.startedAt ?? agent.createdAt ?? now;
  const seconds = Math.max(0, (agent.completedAt ?? now) - start) / 1000;
  return seconds < 60
    ? `${seconds.toFixed(1)}s`
    : `${Math.floor(seconds / 60)}m${Math.floor(seconds % 60)}s`;
}

export function agentStats(agent: AgentSnapshot, now = Date.now()): string {
  const tokens = agent.totalTokens ?? 0;
  const count = tokens < 1000 ? `${tokens}` : `${(tokens / 1000).toFixed(1)}k`;
  const context =
    agent.contextPercent === undefined
      ? ""
      : `${Math.round(agent.contextPercent)}%`;
  const compaction = agent.compactionCount ? `↻${agent.compactionCount}` : "";
  const signals = [context, compaction].filter(Boolean).join(" · ");
  return `⟳${agent.turnCount ?? 0} · ${agent.toolUses ?? 0} tools · ${count} tokens${signals ? ` (${signals})` : ""} · ${duration(agent, now)}`;
}

export function statusIcon(agent: AgentSnapshot, theme: Theme, now: number) {
  if (agent.sessionState === "disconnected") return theme.fg("error", "✗");
  if (isBusy(agent)) {
    return theme.fg("accent", frames[Math.floor(now / 200) % frames.length]);
  }
  if (agent.status === "completed") return theme.fg("success", "✓");
  if (agent.status === "error" || agent.status === "disconnected") {
    return theme.fg("error", "✗");
  }
  return theme.fg("dim", agent.status === "queued" ? "◦" : "■");
}

export function nativeViewAvailable(agent: AgentSnapshot): boolean {
  if (agent.sessionState === "closed") return false;
  if (agent.terminalId) return true;
  return (
    agent.capabilities?.retainedSession === true &&
    ["running", "idle", "interactive"].includes(agent.sessionState ?? "") &&
    !["queued", "starting", "disconnected"].includes(agent.status) &&
    (agent.status !== "error" || agent.sessionState === "idle") &&
    (!["running", "stopping"].includes(agent.status) ||
      agent.capabilities.concurrentNativeInput)
  );
}

export interface AgentWidgetHit {
  x: number;
  y: number;
  width: number;
  agentId: string;
}

export function renderAgentWidget(
  agents: AgentSnapshot[],
  theme: Theme,
  width: number,
  now = Date.now(),
): string[] {
  return layoutAgentWidget(agents, theme, width, now).lines;
}

export function layoutAgentWidget(
  agents: AgentSnapshot[],
  theme: Theme,
  width: number,
  now = Date.now(),
): { lines: string[]; hits: AgentWidgetHit[] } {
  if (width < 1 || !agents.length) return { lines: [], hits: [] };
  const bounds = widgetContentBounds(width);
  const queued = agents.filter((agent) => agent.status === "queued").length;
  const active = agents.filter(isBusy);
  const finished = agents.filter(
    (agent) => !isBusy(agent) && agent.status !== "queued",
  );
  // Bounded height; active agents take priority over retained finished rows.
  const nodes: TreeNode<string>[] = active.slice(0, 4).map((agent) => {
    const interactive = agent.sessionState === "interactive";
    return {
      content: agentHeader(agent, theme, now),
      data: agent.id,
      children: [
        {
          marker: "⎿",
          content: theme.fg(
            "muted",
            `${oneLine(interactive ? (agent.sessionActivity ?? "User interaction") : (agent.activity ?? agent.status))}${interactive ? "" : ` · ${agentStats(agent, now)}`}`,
          ),
        },
      ],
    };
  });
  let rowCount = nodes.length * 2;
  if (active.length > 4) {
    nodes.push({
      content: theme.fg("dim", `${active.length - 4} more active`),
    });
    rowCount += 1;
  }
  if (queued) {
    nodes.push({ content: theme.fg("dim", `${queued} queued`) });
    rowCount += 1;
  }
  const remaining = Math.max(0, 10 - rowCount);
  if (remaining) {
    nodes.push(
      ...finished.slice(-remaining).map((agent) => ({
        content: `${agentHeader(agent, theme, now)} · ${agentStats(agent, now)}`,
        data: agent.id,
      })),
    );
  }
  const rows = renderTree(nodes, theme, bounds.width);
  const hits: AgentWidgetHit[] = rows.flatMap((row, index) =>
    row.data === undefined
      ? []
      : [
          {
            x: bounds.x,
            y: bounds.y + index,
            width: bounds.width,
            agentId: row.data,
          },
        ],
  );
  return {
    lines: renderWidgetFrame("Subagents", theme, width, () =>
      rows.map((row) => row.text),
    ),
    hits,
  };
}
