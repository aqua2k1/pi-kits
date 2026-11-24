import type {
  ExtensionUIContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import {
  type KeybindingsManager,
  SelectList,
  type TUI,
  type TuiMouseEvent,
  type TuiMouseEventResult,
  truncateToWidth,
} from "@earendil-works/pi-tui";
import {
  DockedPanelFrame,
  type DockedPanelLayout,
  type DockedPanelLifecycle,
  dockedListBudget,
  dockedPanelLayout,
  runDockedPanel,
} from "../../../shared/ui/docked-panel/index.ts";
import { type AgentSnapshot, nativeViewHint } from "../manager.ts";
import {
  type AgentSource,
  agentDisplayStatus,
  agentHeader,
  duration,
  oneLine,
} from "./presentation.ts";

export type ViewAction = "open" | "focus" | "close" | "stop" | "delete";

export interface ViewChoice {
  agentId: string;
  action: ViewAction;
}

export interface ViewActionResult {
  message?: string;
  closePanel?: boolean;
}

export interface ViewPanelResult {
  choice?: ViewChoice;
}

export interface SubagentViewsPanel {
  render(width: number): string[];
  handleInput(data: string): void;
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined;
  invalidate(): void;
  cancel(): void;
  dispose(): void;
}

export function createSubagentViewsPanel(
  tui: TUI,
  theme: Theme,
  keys: KeybindingsManager,
  source: AgentSource,
  done: (result: ViewPanelResult | undefined) => void,
  onAction: (choice: ViewChoice) => Promise<ViewActionResult>,
  initialId?: string,
): SubagentViewsPanel {
  let selectedId: string | undefined = initialId ?? source.list()[0]?.id;
  let selectedIndex = 0;
  let deleteId: string | undefined;
  let busy = false;
  let message: string | undefined;
  let finished = false;
  let disposed = false;
  let hits: { y: number; agentId: string }[] = [];

  const unsubscribe = source.subscribe(() => {
    if (!finished) tui.requestRender();
  });

  const selected = () => {
    const agents = source.list();
    const found = agents.findIndex((agent) => agent.id === selectedId);
    const index =
      found >= 0
        ? found
        : Math.max(0, Math.min(selectedIndex, agents.length - 1));
    selectedIndex = index;
    selectedId = agents[index]?.id;
    return { agents, index, agent: agents[index] };
  };

  const cancel = (): void => {
    if (finished) return;
    finished = true;
    done(undefined);
  };

  const act = async (choice: ViewChoice): Promise<void> => {
    if (busy) return;
    busy = true;
    message = "Working…";
    tui.requestRender();
    try {
      const result = await onAction(choice);
      if (finished) return;
      message = result.message;
      if (result.closePanel) {
        finished = true;
        done({ choice });
      }
    } catch (error) {
      message = oneLine(error instanceof Error ? error.message : String(error));
    } finally {
      busy = false;
      if (!finished) tui.requestRender();
    }
  };

  const confirm = (): void => {
    const { agent } = selected();
    if (!agent || !nativeViewHint(agent)) return;
    void act({
      agentId: agent.id,
      action: agent.viewId ? "focus" : "open",
    });
  };

  const move = (delta: number): void => {
    const { agents, index } = selected();
    const next = Math.max(0, Math.min(agents.length - 1, index + delta));
    selectedId = agents[next]?.id;
    tui.requestRender();
  };

  const handleDeleteConfirmation = (data: string, agentId: string): void => {
    if (keys.matches(data, "tui.select.cancel") || data === "n") {
      deleteId = undefined;
      tui.requestRender();
      return;
    }
    if (!keys.matches(data, "tui.select.confirm")) return;

    deleteId = undefined;
    if (source.list().some((agent) => agent.id === agentId)) {
      void act({ agentId, action: "delete" });
    }
    tui.requestRender();
  };

  const handleAgentShortcut = (data: string): void => {
    const { agent } = selected();
    if (!agent) return;

    switch (data) {
      case "c":
        if (agent.viewId) {
          void act({ agentId: agent.id, action: "close" });
        }
        return;
      case "s":
        void act({ agentId: agent.id, action: "stop" });
        return;
      case "d":
        deleteId = agent.id;
        message = undefined;
        tui.requestRender();
        return;
    }
  };

  const hint = (): string => {
    if (deleteId) return "Delete subagent? Enter confirm · Esc cancel";
    return (
      message ??
      "Enter open/focus · c close view · s stop · d delete · Esc close"
    );
  };

  const description = (
    agents: AgentSnapshot[],
    agent?: AgentSnapshot,
  ): string => {
    if (deleteId) {
      const deleting = agents.find((item) => item.id === deleteId);
      return `Delete ${oneLine(deleting?.description ?? "subagent")} (${oneLine(deleteId)})?`;
    }
    return agent ? agentHeader(agent, theme) : "No subagents in this session";
  };

  const detail = (agent: AgentSnapshot): string => {
    if (deleteId)
      return "Closes terminal and removes record. Session files are retained.";
    if (agent.supportsView === false)
      return "Headless subprocess mode; interactive terminal view unavailable";
    if (agent.sessionState === "closed")
      return "Process released; result and session file retained for resume";
    if (!nativeViewHint(agent)) return "Terminal not ready; waiting…";

    const activity =
      agent.sessionState === "interactive"
        ? oneLine(agent.sessionActivity ?? "User interaction")
        : duration(agent);
    return `${agent.id} · ${agentDisplayStatus(agent)} · ${activity}`;
  };

  const renderCompact = (
    frame: DockedPanelFrame,
    rows: number,
    width: number,
  ): string[] => {
    const { agents, agent } = selected();
    const currentHint = hint();
    const hasFeedback = !!(deleteId || message);
    const desc = description(agents, agent);
    const status = agent ? agentDisplayStatus(agent) : "No agents";

    if (agent && rows >= 2) {
      hits = [{ y: rows >= 3 ? rows - 2 : 1, agentId: agent.id }];
    }
    return frame.finish([
      ...frame.heading([], 0),
      ...frame.compactBody({
        progress: hasFeedback ? currentHint : status,
        title: [hasFeedback ? currentHint : desc],
        detail: [],
        kind: "value",
        active: () => [
          truncateToWidth(
            agent ? agentHeader(agent, theme) : "No subagents",
            width,
          ),
        ],
      }),
    ]);
  };

  const appendAgentList = (
    lines: string[],
    layout: DockedPanelLayout,
    width: number,
    agents: AgentSnapshot[],
    index: number,
  ): void => {
    const { budget, visible } = dockedListBudget(
      layout,
      lines.length,
      0,
      agents.length,
    );
    if (!agents.length || !budget) return;

    const items = agents.map((agent) => ({
      value: agent.id,
      label: agentHeader(agent, theme),
    }));
    const list = new SelectList(items, visible, {
      selectedPrefix: (text) => theme.fg("accent", text),
      selectedText: (text) => theme.fg("accent", text),
      description: (text) => theme.fg("muted", text),
      scrollInfo: (text) => theme.fg("dim", text),
      noMatch: (text) => theme.fg("warning", text),
    });
    list.setSelectedIndex(index);
    const first = Math.max(
      0,
      Math.min(index - Math.floor(visible / 2), items.length - visible),
    );
    hits = items.slice(first, first + visible).map((item, offset) => ({
      y: lines.length + offset,
      agentId: item.value,
    }));
    lines.push(...list.render(width).slice(0, budget));
  };

  return {
    cancel,
    dispose() {
      if (disposed) return;
      disposed = true;
      finished = true;
      unsubscribe();
      hits = [];
    },
    invalidate() {},
    handleInput(data: string) {
      if (finished || data.startsWith("\x1b[<")) return;
      if (deleteId) {
        handleDeleteConfirmation(data, deleteId);
        return;
      }
      if (keys.matches(data, "tui.select.cancel")) {
        cancel();
        return;
      }
      if (busy) return;

      if (keys.matches(data, "tui.select.confirm")) confirm();
      else if (keys.matches(data, "tui.select.up")) move(-1);
      else if (keys.matches(data, "tui.select.down")) move(1);
      else if (keys.matches(data, "tui.select.pageUp")) move(-5);
      else if (keys.matches(data, "tui.select.pageDown")) move(5);
      else handleAgentShortcut(data);
    },
    handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
      if (finished || busy || deleteId) return;
      if (event.type === "wheel" && event.wheelDelta) {
        move(event.wheelDelta);
        return { handled: true };
      }
      if (event.button !== "left") return;
      const hit = hits.find((item) => item.y === event.y);
      if (!hit || !source.list().some((agent) => agent.id === hit.agentId))
        return;
      if (event.type === "press") return { handled: true, focus: true };
      if (event.type !== "click") return;
      selectedId = hit.agentId;
      confirm();
      if (!finished) tui.requestRender();
      return { handled: true, focus: !finished };
    },
    render(width: number): string[] {
      hits = [];
      if (width < 1) return [];

      const layout = {
        ...dockedPanelLayout(tui.terminal.rows),
        showTabs: false,
      };
      if (layout.showHints) layout.pinnedLines -= 1;
      const frame = new DockedPanelFrame(
        layout,
        width,
        theme,
        "Subagent views",
      );
      if (layout.rows < 7) return renderCompact(frame, layout.rows, width);

      const { agents, index, agent } = selected();
      const lines = frame.heading([], 0);
      lines.push(truncateToWidth(description(agents, agent), width));
      if (agent) {
        lines.push(truncateToWidth(theme.fg("muted", detail(agent)), width));
      }
      appendAgentList(lines, layout, width, agents, index);

      const currentHint = hint();
      if (!layout.showHints) lines.push(theme.fg("muted", currentHint));
      return frame.finish(lines, currentHint);
    },
  };
}

export function showSubagentViews(
  ui: Pick<ExtensionUIContext, "custom">,
  source: AgentSource,
  onAction: (choice: ViewChoice) => Promise<ViewActionResult>,
  initialId?: string,
  lifecycle?: DockedPanelLifecycle,
): Promise<ViewPanelResult | undefined> {
  return runDockedPanel(
    ui,
    (tui, theme, keys, done) =>
      createSubagentViewsPanel(
        tui,
        theme,
        keys,
        source,
        done,
        onAction,
        initialId,
      ),
    { lifecycle, isCancelled: (result) => result === undefined },
  );
}
