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
  type DockedPanelLifecycle,
  dockedListBudget,
  dockedPanelLayout,
  runDockedPanel,
} from "../../../shared/ui/docked-panel/index.ts";
import {
  type AgentSource,
  agentDisplayStatus,
  agentHeader,
  agentStats,
  nativeViewAvailable,
  oneLine,
} from "./presentation.ts";

export type ViewAction = "open" | "focus" | "close" | "copy" | "delete";
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

  render(width: number): string[] {
    this.hits = [];
    if (width < 1) return [];
    const layout = {
      ...dockedPanelLayout(this.tui.terminal.rows),
      showTabs: false,
    };
    const frame = new DockedPanelFrame(
      layout,
      width,
      this.theme,
      "Subagent views",
    );
    const lines = frame.heading([], 0);
    const { agents, index, agent } = this.selected();
    const deleting = agents.find((item) => item.id === this.deleteId);
    const description = this.deleteId
      ? `Delete ${oneLine(deleting?.description ?? "subagent")} (${oneLine(this.deleteId)})?`
      : agent
        ? agentHeader(agent, this.theme)
        : "No subagents in this session";
    const hint = this.deleteId
      ? "Delete subagent? Enter confirm · Esc cancel"
      : (this.message ??
        "Enter open/focus · y copy ID · c close view · d delete · Esc close");
    const items = agents.map((item) => ({
      value: item.id,
      label: agentHeader(item, this.theme),
    }));
    if (layout.rows < 7) {
      if (agent && layout.rows >= 2)
        this.hits = [
          { y: layout.rows >= 3 ? layout.rows - 2 : 1, agentId: agent.id },
        ];
      return frame.finish([
        ...lines,
        ...frame.compactBody({
          progress:
            this.deleteId || this.message
              ? hint
              : agent
                ? agentDisplayStatus(agent)
                : "No agents",
          title: [this.deleteId || this.message ? hint : description],
          detail: [],
          kind: "value",
          active: () => [
            truncateToWidth(items[index]?.label ?? "No subagents", width),
          ],
        }),
      ]);
    }
    lines.push(truncateToWidth(description, width));
    if (agent) {
      lines.push(
        truncateToWidth(
          this.theme.fg(
            "muted",
            this.deleteId
              ? "Closes terminal and removes record. Session files are retained."
              : agent.sessionState === "closed"
                ? "Runtime released; result retained, resume unavailable"
                : nativeViewAvailable(agent)
                  ? agent.terminalId
                    ? `${agent.id.slice(0, 8)} · ${agentDisplayStatus(agent)} · ${agent.sessionState === "interactive" ? "User interaction" : agentStats(agent)}`
                    : "Native view available; Enter to open"
                  : "Terminal not ready; waiting…",
          ),
          width,
        ),
      );
    }
    const { budget, visible } = dockedListBudget(
      layout,
      lines.length,
      0,
      items.length,
    );
    if (items.length && budget) {
      const list = new SelectList(items, visible, {
        selectedPrefix: (text) => this.theme.fg("accent", text),
        selectedText: (text) => this.theme.fg("accent", text),
        description: (text) => this.theme.fg("muted", text),
        scrollInfo: (text) => this.theme.fg("dim", text),
        noMatch: (text) => this.theme.fg("warning", text),
      });
      list.setSelectedIndex(index);
      const startY = lines.length;
      const rendered = list.render(width).slice(0, budget);
      const first = Math.max(
        0,
        Math.min(index - Math.floor(visible / 2), items.length - visible),
      );
      this.hits = items.slice(first, first + visible).map((item, offset) => ({
        y: startY + offset,
        agentId: item.value,
      }));
      lines.push(...rendered);
    }
    lines.push(this.theme.fg("muted", hint));
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
