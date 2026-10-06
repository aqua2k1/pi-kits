import type { Theme } from "@earendil-works/pi-coding-agent";
import { oneLine } from "../../../shared/ui/renderers.ts";
import { renderWidgetFrame } from "../../../shared/ui/widget.ts";
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

export function renderAgentWidget(
  agents: AgentSnapshot[],
  theme: Theme,
  width: number,
  now = Date.now(),
): string[] {
  if (width < 1 || !agents.length) return [];
  const queued = agents.filter((agent) => agent.status === "queued").length;
  const active = agents.filter(isBusy);
  const finished = agents.filter(
    (agent) => !isBusy(agent) && agent.status !== "queued",
  );
  const lines: string[] = [];
  const branch = (text: string) => theme.fg("muted", text);
  // Bounded height; active agents take priority over retained finished rows.
  for (const agent of active.slice(0, 4)) {
    const interactive = agent.sessionState === "interactive";
    lines.push(
      `${branch("├─")} ${agentHeader(agent, theme, now)}`,
      theme.fg(
        "muted",
        `│   ⎿ ${oneLine(interactive ? (agent.sessionActivity ?? "User interaction") : (agent.activity ?? agent.status))}${interactive ? "" : ` · ${agentStats(agent, now)}`}`,
      ),
    );
  }
  if (active.length > 4) {
    lines.push(
      `${branch("├─")} ${theme.fg("dim", `${active.length - 4} more active`)}`,
    );
  }
  if (queued) {
    lines.push(`${branch("├─")} ${theme.fg("dim", `${queued} queued`)}`);
  }
  for (const agent of finished.slice(-Math.max(0, 10 - lines.length))) {
    if (lines.length >= 10) break;
    lines.push(
      `${branch("├─")} ${agentHeader(agent, theme, now)} · ${agentStats(agent, now)}`,
    );
  }
  if (lines.length) {
    lines[lines.length - 1] = lines[lines.length - 1].replace("├─", "└─");
  }
  return renderWidgetFrame("Subagents", theme, width, () => lines);
}
