import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  stripTerminalSequences,
  truncateToWidth,
} from "@earendil-works/pi-tui";
import type { AgentSnapshot, AgentStatus } from "./manager.ts";

export interface AgentSource {
  list(): AgentSnapshot[];
  subscribe(listener: () => void): () => void;
}

const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function isWorking(status: AgentStatus): boolean {
  return status === "starting" || status === "running" || status === "stopping";
}

export function oneLine(text: string): string {
  // Never allow model-supplied text to inject terminal controls into widgets.
  return stripTerminalSequences(text)
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, " ")
    .trim();
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
  if (isWorking(agent.status)) {
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
  const active = agents.filter((agent) => isWorking(agent.status));
  const finished = agents.filter(
    (agent) => !isWorking(agent.status) && agent.status !== "queued",
  );
  const lines = [theme.fg("accent", theme.bold("● Subagents"))];
  // Bounded height; active agents take priority over retained finished rows.
  for (const agent of active.slice(0, 4)) {
    lines.push(
      `├─ ${statusIcon(agent, theme, now)} ${oneLine(agent.description)} · ${agentStats(agent, now)}`,
      theme.fg("muted", `│   ⎿ ${oneLine(agent.activity ?? agent.status)}`),
    );
  }
  if (active.length > 4) {
    lines.push(theme.fg("dim", `├─ ${active.length - 4} more active`));
  }
  if (queued) lines.push(theme.fg("dim", `├─ ${queued} queued`));
  for (const agent of finished.slice(-Math.max(0, 11 - lines.length))) {
    if (lines.length >= 11) break;
    lines.push(
      `├─ ${statusIcon(agent, theme, now)} ${oneLine(agent.description)} · ${agent.status} · ${agentStats(agent, now)}`,
    );
  }
  if (lines.length > 1) {
    lines[lines.length - 1] = lines[lines.length - 1].replace("├─", "└─");
  }
  return lines.map((line) => truncateToWidth(line, width));
}
