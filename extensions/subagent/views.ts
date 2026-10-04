import type {
  ExtensionUIContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import {
  type KeybindingsManager,
  matchesKey,
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
} from "../../shared/ui/docked-panel/index.ts";
import { layoutTabs, type TabLayout, tabAt } from "../../shared/ui/tabs.ts";
import {
  type AgentSource,
  agentDisplayStatus,
  agentStats,
  agentTitle,
  statusIcon,
} from "./presentation.ts";

export type ViewAction = "open" | "focus" | "close";
export interface ViewChoice {
  agentId: string;
  action: ViewAction;
}

export class SubagentViewsPanel {
  private selectedId?: string;
  private phase: "agents" | "actions";
  private actionIndex = 0;
  private finished = false;
  private disposed = false;
  private readonly unsubscribe: () => void;
  private tabs: TabLayout[] = [];
  private hits: { y: number; index: number }[] = [];

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly keys: KeybindingsManager,
    private readonly source: AgentSource,
    private readonly done: (choice: ViewChoice | undefined) => void,
    initialId?: string,
  ) {
    this.selectedId = initialId ?? source.list()[0]?.id;
    this.phase = initialId ? "actions" : "agents";
    this.unsubscribe = source.subscribe(() => {
      if (!this.finished) this.tui.requestRender();
    });
  }

  private selected() {
    const agents = this.source.list();
    const index = Math.max(
      0,
      agents.findIndex((agent) => agent.id === this.selectedId),
    );
    this.selectedId = agents[index]?.id;
    return { agents, index, agent: agents[index] };
  }

  private actions(): { value: ViewAction; label: string }[] {
    const { agent } = this.selected();
    if (!agent?.terminalId) return [];
    if (agent.viewId) {
      return [
        { value: "focus", label: "Focus existing view" },
        { value: "close", label: "Close view · keep worker running" },
      ];
    }
    return [{ value: "open", label: "Open view · automatic right-side stack" }];
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
    this.tabs = [];
    this.hits = [];
  }

  invalidate(): void {}

  private confirm(): void {
    const { agent } = this.selected();
    if (!agent) return;
    if (this.phase === "agents") {
      this.phase = "actions";
      this.actionIndex = 0;
      this.tui.requestRender();
      return;
    }
    const actions = this.actions();
    const action = actions[Math.min(this.actionIndex, actions.length - 1)];
    if (!action) return;
    this.finished = true;
    this.done({ agentId: agent.id, action: action.value });
  }

  handleInput(data: string): void {
    if (this.finished || data.startsWith("\x1b[<")) return;
    if (this.keys.matches(data, "tui.select.cancel")) {
      this.cancel();
      return;
    }
    if (this.keys.matches(data, "tui.select.confirm")) {
      this.confirm();
      return;
    }
    if (matchesKey(data, "left") || matchesKey(data, "backspace")) {
      this.phase = "agents";
    } else if (matchesKey(data, "tab") || matchesKey(data, "right")) {
      this.phase = this.phase === "agents" ? "actions" : "agents";
      this.actionIndex = 0;
    } else {
      let delta = 0;
      if (this.keys.matches(data, "tui.select.up")) delta = -1;
      if (this.keys.matches(data, "tui.select.down")) delta = 1;
      if (this.keys.matches(data, "tui.select.pageUp")) delta = -5;
      if (this.keys.matches(data, "tui.select.pageDown")) delta = 5;
      if (!delta) return;
      const { agents, index } = this.selected();
      if (this.phase === "agents") {
        const next = Math.max(0, Math.min(agents.length - 1, index + delta));
        this.selectedId = agents[next]?.id;
      } else {
        this.actionIndex = Math.max(
          0,
          Math.min(this.actions().length - 1, this.actionIndex + delta),
        );
      }
    }
    this.tui.requestRender();
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (this.finished) return;
    if (event.type === "wheel" && event.wheelDelta) {
      const { agents, index } = this.selected();
      if (this.phase === "agents") {
        const next = Math.max(
          0,
          Math.min(agents.length - 1, index + event.wheelDelta),
        );
        this.selectedId = agents[next]?.id;
      } else {
        this.actionIndex = Math.max(
          0,
          Math.min(
            this.actions().length - 1,
            this.actionIndex + event.wheelDelta,
          ),
        );
      }
      this.tui.requestRender();
      return { handled: true };
    }
    if (event.button !== "left") return;
    const tab = tabAt(this.tabs, event.x, event.y - 1);
    const hit = this.hits.find((item) => item.y === event.y);
    if (tab === undefined && !hit) return;
    if (event.type === "press") return { handled: true, focus: true };
    if (event.type !== "click") return;
    if (tab !== undefined) {
      this.phase = tab === 0 ? "agents" : "actions";
      this.actionIndex = 0;
    } else if (hit) {
      if (this.phase === "agents") {
        this.selectedId = this.source.list()[hit.index]?.id;
      } else {
        this.actionIndex = hit.index;
        this.confirm();
      }
    }
    if (!this.finished) this.tui.requestRender();
    return { handled: true, focus: !this.finished };
  }

  render(width: number): string[] {
    this.hits = [];
    this.tabs = [];
    if (width < 1) return [];
    const layout = dockedPanelLayout(this.tui.terminal.rows);
    const frame = new DockedPanelFrame(
      layout,
      width,
      this.theme,
      "Subagent views",
    );
    const phase = this.phase === "agents" ? 0 : 1;
    this.tabs =
      layout.showTabs && layout.rows >= 7
        ? layoutTabs(["[Agents]", "[Actions]"], phase, width)
        : [];
    const lines = frame.heading(this.tabs, phase);
    const { agents, index, agent } = this.selected();
    const description = agent
      ? agentTitle(agent)
      : "No subagents in this session";
    lines.push(truncateToWidth(description, width));
    if (layout.rows >= 7 && agent) {
      lines.push(
        truncateToWidth(
          this.theme.fg(
            "muted",
            `${agent.id.slice(0, 8)} · ${agentDisplayStatus(agent)} · ${agent.sessionState === "interactive" ? "User interaction" : agentStats(agent)}`,
          ),
          width,
        ),
      );
    }
    const actions = this.actions();
    const items =
      phase === 0
        ? agents.map((item) => ({
            value: item.id,
            label: `${statusIcon(item, this.theme, Date.now())} ${agentTitle(item)} · ${item.id.slice(0, 8)} · ${agentDisplayStatus(item)}`,
          }))
        : actions.map((action) => ({
            value: action.value,
            label: action.label,
          }));
    const selected =
      phase === 0
        ? index
        : Math.min(this.actionIndex, Math.max(0, items.length - 1));
    if (layout.rows < 7) {
      return frame.finish([
        ...frame.heading([], phase),
        ...frame.compactBody({
          progress: agent ? agentDisplayStatus(agent) : "No agents",
          title: [description],
          detail: [],
          kind: "value",
          active: () => [
            truncateToWidth(
              items[selected]?.label ??
                (agent ? "Terminal not ready" : "No subagents"),
              width,
            ),
          ],
        }),
      ]);
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
      list.setSelectedIndex(selected);
      const startY = lines.length;
      const rendered = list.render(width).slice(0, budget);
      const first = Math.max(
        0,
        Math.min(selected - Math.floor(visible / 2), items.length - visible),
      );
      this.hits = items.slice(first, first + visible).map((_item, offset) => ({
        y: startY + offset,
        index: first + offset,
      }));
      lines.push(...rendered);
    } else if (items.length && layout.rows >= 3) {
      lines.push(
        truncateToWidth(this.theme.fg("accent", items[selected].label), width),
      );
    } else if (phase === 1 && agent) {
      lines.push(this.theme.fg("muted", "Terminal not ready; waiting…"));
    }
    lines.push(this.theme.fg("muted", "Enter: select · Esc: close"));
    return frame.finish(
      lines,
      "↑↓ select · Enter · Tab switch · ← back · Esc close",
    );
  }
}

export function showSubagentViews(
  ui: Pick<ExtensionUIContext, "custom">,
  source: AgentSource,
  initialId?: string,
  lifecycle?: DockedPanelLifecycle,
): Promise<ViewChoice | undefined> {
  return runDockedPanel(
    ui,
    (tui, theme, keys, done) =>
      new SubagentViewsPanel(tui, theme, keys, source, done, initialId),
    { lifecycle, isCancelled: (result) => result === undefined },
  );
}
