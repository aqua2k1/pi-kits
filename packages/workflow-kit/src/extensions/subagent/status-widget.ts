import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import {
  type AgentSource,
  isWorking,
  renderAgentWidget,
} from "./presentation.ts";

export const SUBAGENT_WIDGET = "pi-kits:subagents";
const FINISHED_LINGER_MS = 5_000;

export interface WidgetClock {
  now(): number;
  repeat(callback: () => void): () => void;
}

const defaultClock: WidgetClock = {
  now: Date.now,
  repeat(callback) {
    const timer = setInterval(callback, 200);
    timer.unref();
    return () => clearInterval(timer);
  },
};

/** Presentation only: no commands, lifecycle hooks, or mux operations. */
export class SubagentStatusWidget {
  private ui?: ExtensionUIContext;
  private tui?: TUI;
  private registered = false;
  private disposed = false;
  private cancelTimer?: () => void;
  private readonly unsubscribe: () => void;
  private lastStatus?: string;

  constructor(
    private readonly source: AgentSource,
    private readonly clock: WidgetClock = defaultClock,
  ) {
    this.unsubscribe = source.subscribe(() => this.refresh());
  }

  bind(ui: ExtensionUIContext): void {
    if (this.disposed) return;
    if (ui !== this.ui) {
      this.clear();
      this.ui = ui;
    }
    this.refresh();
  }

  private visible() {
    const now = this.clock.now();
    return this.source
      .list()
      .filter(
        (agent) =>
          isWorking(agent.status) ||
          agent.status === "queued" ||
          agent.status === "disconnected" ||
          (agent.completedAt !== undefined &&
            now - agent.completedAt < FINISHED_LINGER_MS),
      );
  }

  refresh(): void {
    if (this.disposed || !this.ui) return;
    const agents = this.visible();
    if (!agents.length) {
      this.clear();
      return;
    }
    const running = agents.filter((agent) => isWorking(agent.status)).length;
    const queued = agents.filter((agent) => agent.status === "queued").length;
    const errors = agents.filter(
      (agent) => agent.status === "error" || agent.status === "disconnected",
    ).length;
    const status = [
      `${running} active`,
      ...(queued ? [`${queued} queued`] : []),
      ...(errors ? [`${errors} errors`] : []),
    ].join(" · ");
    if (status !== this.lastStatus) {
      this.ui.setStatus(SUBAGENT_WIDGET, `Subagents: ${status}`);
      this.lastStatus = status;
    }
    if (!this.registered) {
      this.registered = true;
      this.ui.setWidget(
        SUBAGENT_WIDGET,
        (tui, theme) => {
          this.tui = tui;
          return {
            render: (width) =>
              renderAgentWidget(this.visible(), theme, width, this.clock.now()),
            invalidate() {},
          };
        },
        { placement: "aboveEditor" },
      );
    }
    this.tui?.requestRender();
    // Persistent animation for active tasks; finished rows expire after a
    // short grace period. Disconnected errors remain, without a spinning timer.
    const needsTimer = agents.some(
      (agent) => isWorking(agent.status) || agent.completedAt !== undefined,
    );
    if (needsTimer && !this.cancelTimer) {
      this.cancelTimer = this.clock.repeat(() => this.refresh());
    } else if (!needsTimer && this.cancelTimer) {
      this.cancelTimer();
      this.cancelTimer = undefined;
    }
  }

  private clear(): void {
    this.cancelTimer?.();
    this.cancelTimer = undefined;
    if (this.registered) this.ui?.setWidget(SUBAGENT_WIDGET, undefined);
    if (this.lastStatus !== undefined) {
      this.ui?.setStatus(SUBAGENT_WIDGET, undefined);
    }
    this.registered = false;
    this.lastStatus = undefined;
    this.tui = undefined;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe();
    this.clear();
    this.ui = undefined;
  }
}
