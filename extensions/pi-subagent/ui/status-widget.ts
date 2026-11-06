import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { TUI, TuiMouseEvent } from "@earendil-works/pi-tui";
import { hasDisplayError } from "../policy.ts";
import {
  type AgentSource,
  type AgentWidgetHit,
  isBusy,
  isWorking,
  layoutAgentWidget,
  nativeViewAvailable,
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
  private readonly opening = new Set<string>();

  constructor(
    private readonly source: AgentSource,
    private readonly clock: WidgetClock = defaultClock,
    private readonly onOpen?: (agentId: string) => Promise<void> | void,
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
          isBusy(agent) ||
          agent.status === "queued" ||
          agent.status === "disconnected" ||
          agent.sessionState === "disconnected" ||
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
    const interactive = agents.filter(
      (agent) => agent.sessionState === "interactive",
    ).length;
    const errors = agents.filter(hasDisplayError).length;
    const status = [
      `${running} active`,
      ...(interactive ? [`${interactive} interactive`] : []),
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
          let hits: AgentWidgetHit[] = [];
          return {
            render: (width) => {
              const layout = layoutAgentWidget(
                this.visible(),
                theme,
                width,
                this.clock.now(),
              );
              hits = layout.hits;
              return layout.lines;
            },
            handleMouse: (event: TuiMouseEvent) => {
              if (this.disposed || !this.onOpen || event.button !== "left")
                return;
              const hit = hits.find(
                (item) =>
                  item.y === event.y &&
                  event.x >= item.x &&
                  event.x < item.x + item.width,
              );
              const agent =
                hit && this.visible().find((item) => item.id === hit.agentId);
              if (
                !agent ||
                agent.status === "queued" ||
                !nativeViewAvailable(agent)
              )
                return;
              if (event.type === "press")
                return { handled: true, render: false };
              if (event.type !== "click") return;
              if (!this.opening.has(agent.id)) {
                this.opening.add(agent.id);
                void this.dispatchOpen(agent.id);
              }
              return { handled: true, render: false };
            },
            invalidate() {
              hits = [];
            },
          };
        },
        { placement: "aboveEditor" },
      );
    }
    this.tui?.requestRender();
    // Persistent animation for active tasks; finished rows expire after a
    // short grace period. Disconnected errors remain, without a spinning timer.
    const needsTimer = agents.some(
      (agent) =>
        isBusy(agent) ||
        (agent.completedAt !== undefined &&
          this.clock.now() - agent.completedAt < FINISHED_LINGER_MS),
    );
    if (needsTimer && !this.cancelTimer) {
      this.cancelTimer = this.clock.repeat(() => this.refresh());
    } else if (!needsTimer && this.cancelTimer) {
      this.cancelTimer();
      this.cancelTimer = undefined;
    }
  }

  private async dispatchOpen(agentId: string): Promise<void> {
    try {
      await this.onOpen?.(agentId);
    } catch (error) {
      if (!this.disposed) {
        this.ui?.notify(
          error instanceof Error ? error.message : String(error),
          "error",
        );
      }
    } finally {
      this.opening.delete(agentId);
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
