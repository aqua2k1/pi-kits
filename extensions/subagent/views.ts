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
} from "../../shared/ui/docked-panel/index.ts";
import type { AgentSnapshot } from "./manager.ts";
import {
  type AgentSource,
  agentDisplayStatus,
  agentHeader,
  agentStats,
} from "./presentation.ts";

export type ViewAction = "open" | "focus" | "close" | "copy" | "delete";
export interface ViewChoice {
  agentId: string;
  action: ViewAction;
}

function nativeViewAvailable(agent: AgentSnapshot): boolean {
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

export class SubagentViewsPanel {
  private selectedId?: string;
  private finished = false;
  private disposed = false;
  private readonly unsubscribe: () => void;
  private hits: { y: number; agentId: string }[] = [];

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly keys: KeybindingsManager,
    private readonly source: AgentSource,
    private readonly done: (choice: ViewChoice | undefined) => void,
    initialId?: string,
  ) {
    this.selectedId = initialId ?? source.list()[0]?.id;
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

  private confirm(): void {
    const { agent } = this.selected();
    if (!agent || !nativeViewAvailable(agent)) return;
    this.finished = true;
    this.done({ agentId: agent.id, action: agent.viewId ? "focus" : "open" });
  }

  private move(delta: number): void {
    const { agents, index } = this.selected();
    const next = Math.max(0, Math.min(agents.length - 1, index + delta));
    this.selectedId = agents[next]?.id;
    this.tui.requestRender();
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
    if (data === "y" || data === "d") {
      const { agent } = this.selected();
      if (!agent) return;
      this.finished = true;
      this.done({
        agentId: agent.id,
        action: data === "y" ? "copy" : "delete",
      });
      return;
    }
    if (this.keys.matches(data, "tui.select.up")) this.move(-1);
    else if (this.keys.matches(data, "tui.select.down")) this.move(1);
    else if (this.keys.matches(data, "tui.select.pageUp")) this.move(-5);
    else if (this.keys.matches(data, "tui.select.pageDown")) this.move(5);
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (this.finished) return;
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
    const description = agent
      ? agentHeader(agent, this.theme)
      : "No subagents in this session";
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
          progress: agent ? agentDisplayStatus(agent) : "No agents",
          title: [description],
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
            agent.terminalId
              ? `${agent.id.slice(0, 8)} · ${agentDisplayStatus(agent)} · ${agent.sessionState === "interactive" ? "User interaction" : agentStats(agent)}`
              : nativeViewAvailable(agent)
                ? "Native view available; Enter to open"
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
    lines.push(
      this.theme.fg(
        "muted",
        "Enter: open/focus · y: copy ID · d: delete · Esc: close",
      ),
    );
    return frame.finish(
      lines,
      "↑↓ select · Enter open/focus · y copy ID · d delete · Esc close",
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
