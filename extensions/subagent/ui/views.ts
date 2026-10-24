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
import type { AgentSnapshot } from "../manager.ts";
import {
  type AgentSource,
  agentDisplayStatus,
  agentHeader,
  agentStats,
  nativeViewAvailable,
  oneLine,
} from "./presentation.ts";

export type ViewAction =
  | "open"
  | "focus"
  | "close"
  | "copy"
  | "stop"
  | "delete";
export interface ViewChoice {
  agentId: string;
  action: ViewAction;
}

export interface ViewActionResult {
  message?: string;
  closePanel?: boolean;
}

/** A choice still needs execution; an empty result means the action already ran. */
export interface ViewPanelResult {
  choice?: ViewChoice;
}

export class SubagentViewsPanel {
  private selectedId?: string;
  private selectedIndex = 0;
  private deleteId?: string;
  private busy = false;
  private message?: string;
  private finished = false;
  private disposed = false;
  private readonly unsubscribe: () => void;
  private hits: { y: number; agentId: string }[] = [];

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly keys: KeybindingsManager,
    private readonly source: AgentSource,
    private readonly done: (result: ViewPanelResult | undefined) => void,
    private readonly onAction: (
      choice: ViewChoice,
    ) => Promise<ViewActionResult>,
    initialId?: string,
  ) {
    this.selectedId = initialId ?? source.list()[0]?.id;
    this.unsubscribe = source.subscribe(() => {
      if (!this.finished) this.tui.requestRender();
    });
  }

  private selected() {
    const agents = this.source.list();
    const found = agents.findIndex((agent) => agent.id === this.selectedId);
    const index =
      found >= 0
        ? found
        : Math.max(0, Math.min(this.selectedIndex, agents.length - 1));
    this.selectedIndex = index;
    this.selectedId = agents[index]?.id;
    return { agents, index, agent: agents[index] };
  }

  cancel(): void {
    if (this.finished) return;
    this.finished = true;
    this.done(undefined);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.finished = true;
    this.unsubscribe();
    this.hits = [];
  }

  invalidate(): void {}

  private async act(choice: ViewChoice): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.message = "Working…";
    this.tui.requestRender();
    try {
      const result = await this.onAction(choice);
      if (this.finished) return;
      this.message = result.message;
      if (result.closePanel) {
        this.finished = true;
        this.done({});
      }
    } catch (error) {
      this.message = oneLine(
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      this.busy = false;
      if (!this.finished) this.tui.requestRender();
    }
  }

  private confirm(): void {
    const { agent } = this.selected();
    if (!agent || !nativeViewAvailable(agent)) return;
    this.finished = true;
    this.done({
      choice: { agentId: agent.id, action: agent.viewId ? "focus" : "open" },
    });
  }

  private move(delta: number): void {
    const { agents, index } = this.selected();
    const next = Math.max(0, Math.min(agents.length - 1, index + delta));
    this.selectedId = agents[next]?.id;
    this.tui.requestRender();
  }

  private handleDeleteConfirmation(data: string, agentId: string): void {
    if (this.keys.matches(data, "tui.select.cancel") || data === "n") {
      this.deleteId = undefined;
      this.tui.requestRender();
      return;
    }
    if (!this.keys.matches(data, "tui.select.confirm")) return;

    this.deleteId = undefined;
    if (this.source.list().some((agent) => agent.id === agentId)) {
      void this.act({ agentId, action: "delete" });
    }
    this.tui.requestRender();
  }

  private handleAgentShortcut(data: string): void {
    const { agent } = this.selected();
    if (!agent) return;

    switch (data) {
      case "y":
        void this.act({ agentId: agent.id, action: "copy" });
        return;
      case "c":
        if (agent.viewId) {
          void this.act({ agentId: agent.id, action: "close" });
        }
        return;
      case "s":
        void this.act({ agentId: agent.id, action: "stop" });
        return;
      case "d":
        this.deleteId = agent.id;
        this.message = undefined;
        this.tui.requestRender();
        return;
    }
  }

  handleInput(data: string): void {
    if (this.finished || data.startsWith("\x1b[<")) return;
    if (this.deleteId) {
      this.handleDeleteConfirmation(data, this.deleteId);
      return;
    }
    if (this.keys.matches(data, "tui.select.cancel")) {
      this.cancel();
      return;
    }
    if (this.busy) return;

    if (this.keys.matches(data, "tui.select.confirm")) this.confirm();
    else if (this.keys.matches(data, "tui.select.up")) this.move(-1);
    else if (this.keys.matches(data, "tui.select.down")) this.move(1);
    else if (this.keys.matches(data, "tui.select.pageUp")) this.move(-5);
    else if (this.keys.matches(data, "tui.select.pageDown")) this.move(5);
    else this.handleAgentShortcut(data);
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (this.finished || this.busy || this.deleteId) return;
    if (event.type === "wheel" && event.wheelDelta) {
      this.move(event.wheelDelta);
      return { handled: true };
    }
    if (event.button !== "left") return;
    const hit = this.hits.find((item) => item.y === event.y);
    if (!hit || !this.source.list().some((agent) => agent.id === hit.agentId))
      return;
    if (event.type === "press") return { handled: true, focus: true };
    if (event.type !== "click") return;
    this.selectedId = hit.agentId;
    this.confirm();
    if (!this.finished) this.tui.requestRender();
    return { handled: true, focus: !this.finished };
  }

  private hint(): string {
    if (this.deleteId) return "Delete subagent? Enter confirm · Esc cancel";
    return (
      this.message ??
      "Enter open/focus · y copy ID · c close view · s stop · d delete · Esc close"
    );
  }

  private description(agents: AgentSnapshot[], agent?: AgentSnapshot): string {
    if (this.deleteId) {
      const deleting = agents.find((item) => item.id === this.deleteId);
      return `Delete ${oneLine(deleting?.description ?? "subagent")} (${oneLine(this.deleteId)})?`;
    }
    return agent
      ? agentHeader(agent, this.theme)
      : "No subagents in this session";
  }

  private detail(agent: AgentSnapshot): string {
    if (this.deleteId)
      return "Closes terminal and removes record. Session files are retained.";
    if (agent.sessionState === "closed")
      return "Runtime released; result retained, resume unavailable";
    if (!nativeViewAvailable(agent)) return "Terminal not ready; waiting…";
    if (!agent.terminalId) return "Native view available; Enter to open";

    const activity =
      agent.sessionState === "interactive"
        ? "User interaction"
        : agentStats(agent);
    return `${agent.id.slice(0, 8)} · ${agentDisplayStatus(agent)} · ${activity}`;
  }

  private renderCompact(
    frame: DockedPanelFrame,
    rows: number,
    width: number,
  ): string[] {
    const { agents, agent } = this.selected();
    const hint = this.hint();
    const hasFeedback = !!(this.deleteId || this.message);
    const description = this.description(agents, agent);
    const status = agent ? agentDisplayStatus(agent) : "No agents";

    if (agent && rows >= 2) {
      this.hits = [{ y: rows >= 3 ? rows - 2 : 1, agentId: agent.id }];
    }
    return frame.finish([
      ...frame.heading([], 0),
      ...frame.compactBody({
        progress: hasFeedback ? hint : status,
        title: [hasFeedback ? hint : description],
        detail: [],
        kind: "value",
        active: () => [
          truncateToWidth(
            agent ? agentHeader(agent, this.theme) : "No subagents",
            width,
          ),
        ],
      }),
    ]);
  }

  private appendAgentList(
    lines: string[],
    layout: DockedPanelLayout,
    width: number,
    agents: AgentSnapshot[],
    index: number,
  ): void {
    const { budget, visible } = dockedListBudget(
      layout,
      lines.length,
      0,
      agents.length,
    );
    if (!agents.length || !budget) return;

    const items = agents.map((agent) => ({
      value: agent.id,
      label: agentHeader(agent, this.theme),
    }));
    const list = new SelectList(items, visible, {
      selectedPrefix: (text) => this.theme.fg("accent", text),
      selectedText: (text) => this.theme.fg("accent", text),
      description: (text) => this.theme.fg("muted", text),
      scrollInfo: (text) => this.theme.fg("dim", text),
      noMatch: (text) => this.theme.fg("warning", text),
    });
    list.setSelectedIndex(index);
    const first = Math.max(
      0,
      Math.min(index - Math.floor(visible / 2), items.length - visible),
    );
    this.hits = items.slice(first, first + visible).map((item, offset) => ({
      y: lines.length + offset,
      agentId: item.value,
    }));
    lines.push(...list.render(width).slice(0, budget));
  }

  render(width: number): string[] {
    this.hits = [];
    if (width < 1) return [];

    const layout = {
      ...dockedPanelLayout(this.tui.terminal.rows),
      showTabs: false,
    };
    // The hint is the only footer control; do not pin the last agent row.
    if (layout.showHints) layout.pinnedLines -= 1;
    const frame = new DockedPanelFrame(
      layout,
      width,
      this.theme,
      "Subagent views",
    );
    if (layout.rows < 7) return this.renderCompact(frame, layout.rows, width);

    const { agents, index, agent } = this.selected();
    const lines = frame.heading([], 0);
    lines.push(truncateToWidth(this.description(agents, agent), width));
    if (agent) {
      lines.push(
        truncateToWidth(this.theme.fg("muted", this.detail(agent)), width),
      );
    }
    this.appendAgentList(lines, layout, width, agents, index);

    const hint = this.hint();
    if (!layout.showHints) lines.push(this.theme.fg("muted", hint));
    return frame.finish(lines, hint);
  }
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
      new SubagentViewsPanel(
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
