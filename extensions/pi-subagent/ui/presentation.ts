import type { Theme } from "@earendil-works/pi-coding-agent";
import { oneLine } from "../../../shared/ui/renderers.ts";
import { renderTree, type TreeNode } from "../../../shared/ui/tree.ts";
import {
  renderWidgetFrame,
  widgetContentBounds,
} from "../../../shared/ui/widget.ts";
import {
  type AgentSnapshot,
  hasDisplayError,
  isDisplayActive,
} from "../manager.ts";

export { oneLine } from "../../../shared/ui/renderers.ts";

export interface AgentSource {
  list(): AgentSnapshot[];
  subscribe(listener: () => void): () => void;
}

const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function agentDisplayStatus(agent: AgentSnapshot): string {
  return agent.sessionState === "interactive" ||
    agent.sessionState === "disconnected" ||
    agent.sessionState === "closed"
    ? `${agent.status} · ${agent.sessionState}`
    : agent.status;
}

const MAX_CONTENT_CHARS = 24_000;

/** Plain-text single-line progress summary (ANSI-free) for onUpdate / RPC / ACP. */
export function formatProgressLine(agent: AgentSnapshot): string {
  return [
    `[${oneLine(agent.id)}] ${agentName(agent)}`,
    oneLine(agent.description),
    agentDisplayStatus(agent),
    ...(agent.round !== undefined ? [`round ${agent.round}`] : []),
    ...(agent.sessionActivity ? [oneLine(agent.sessionActivity)] : []),
  ].join(" · ");
}

/** Plain-text result summary (ANSI-free) for tool content and notifications. */
export function formatSnapshotText(agent: AgentSnapshot): string {
  const meta = [
    `[${oneLine(agent.id)}] ${agentName(agent)}`,
    oneLine(agent.description),
    agentDisplayStatus(agent),
    ...(agent.round !== undefined ? [`round ${agent.round}`] : []),
    ...(agent.cwd ? [`cwd: ${oneLine(agent.cwd)}`] : []),
  ].join(" · ");

  const sections = [meta];
  if (agent.sessionActivity && agent.status === "running") {
    sections.push(`Activity: ${oneLine(agent.sessionActivity)}`);
  }
  if (agent.error) {
    sections.push(`Error: ${agent.error}`);
  } else if (agent.result) {
    sections.push(agent.result);
  }
  if (agent.truncated) {
    sections.push(
      `[Result truncated; full session at ${agent.sessionPath ?? "sessionPath"}]`,
    );
  }
  const footer = [
    ...(agent.sessionPath ? [`Session: ${agent.sessionPath}`] : []),
    ...(agent.hint ? [`Next: ${agent.hint}`] : []),
  ];
  if (footer.length) sections.push(footer.join("\n"));

  const text = sections.join("\n\n");
  return text.length > MAX_CONTENT_CHARS
    ? `${text.slice(0, MAX_CONTENT_CHARS)}\n[Truncated; read the full session file at ${agent.sessionPath ?? "sessionPath"}.]`
    : text;
}

export function agentTitle(agent: AgentSnapshot): string {
  return oneLine(`${agentName(agent)} · ${agent.description}`);
}

export function agentName(agent: AgentSnapshot): string {
  return oneLine(agent.displayName || agent.subagentType || "Subagent");
}

export function agentModel(agent: AgentSnapshot): string {
  return oneLine(agent.model || "—");
}

/** Shared identity/status row for widgets, tool cards and views. */
export function agentHeader(
  agent: AgentSnapshot,
  theme: Theme,
  now = Date.now(),
): string {
  return `${statusIcon(agent, theme, now)} ${agentName(agent)} · ${agentModel(agent)} · ${oneLine(agent.description)} · ${oneLine(agent.id) || "—"} · ${oneLine(agentDisplayStatus(agent))}`;
}

export function duration(agent: AgentSnapshot, now = Date.now()): string {
  const start = agent.startedAt ?? agent.createdAt ?? now;
  const seconds = Math.max(0, (agent.completedAt ?? now) - start) / 1000;
  return seconds < 60
    ? `${seconds.toFixed(1)}s`
    : `${Math.floor(seconds / 60)}m${Math.floor(seconds % 60)}s`;
}

export function statusIcon(agent: AgentSnapshot, theme: Theme, now: number) {
  if (agent.sessionState === "disconnected") return theme.fg("error", "✗");
  if (isDisplayActive(agent)) {
    return theme.fg("accent", frames[Math.floor(now / 200) % frames.length]);
  }
  if (agent.status === "completed") return theme.fg("success", "✓");
  if (hasDisplayError(agent)) {
    return theme.fg("error", "✗");
  }
  return theme.fg("dim", agent.status === "queued" ? "◦" : "■");
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
  const active = agents.filter(isDisplayActive);
  const finished = agents.filter(
    (agent) => !isDisplayActive(agent) && agent.status !== "queued",
  );
  // Bounded height; active agents take priority over retained finished rows.
  const nodes: TreeNode<string>[] = active.slice(0, 4).map((agent) => {
    const interactive = agent.sessionState === "interactive";
    const suffix = interactive
      ? oneLine(agent.sessionActivity ?? "User interaction")
      : duration(agent, now);
    return {
      content: `${agentHeader(agent, theme, now)} · ${suffix}`,
      data: agent.id,
    };
  });
  let rowCount = nodes.length;
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
        content: `${agentHeader(agent, theme, now)} · ${duration(agent, now)}`,
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
