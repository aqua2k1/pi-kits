import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { TUI, TuiMouseEvent } from "@earendil-works/pi-tui";
import {
  hasDisplayError,
  isDisplayActive,
  isWorkingStatus,
  nativeViewHint,
} from "../manager.ts";
import {
  type AgentSource,
  type AgentWidgetHit,
  layoutAgentWidget,
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

export interface SubagentStatusWidget {
  bind(ui: ExtensionUIContext): void;
  refresh(): void;
  dispose(): void;
}

/** Presentation only: no commands, lifecycle hooks, or executor operations. */
export function createSubagentStatusWidget(
  source: AgentSource,
  clock: WidgetClock = defaultClock,
  onOpen?: (agentId: string) => Promise<void> | void,
): SubagentStatusWidget {
  let ui: ExtensionUIContext | undefined;
  let tui: TUI | undefined;
  let registered = false;
  let disposed = false;
  let cancelTimer: (() => void) | undefined;
  let lastStatus: string | undefined;
  const opening = new Set<string>();

  const visible = () => {
    const now = clock.now();
    return source
      .list()
      .filter(
        (agent) =>
          isDisplayActive(agent) ||
          agent.status === "queued" ||
          agent.status === "disconnected" ||
          agent.sessionState === "disconnected" ||
          (agent.completedAt !== undefined &&
            now - agent.completedAt < FINISHED_LINGER_MS),
      );
  };

  const clear = (): void => {
    cancelTimer?.();
    cancelTimer = undefined;
    if (registered) ui?.setWidget(SUBAGENT_WIDGET, undefined);
    if (lastStatus !== undefined) {
      ui?.setStatus(SUBAGENT_WIDGET, undefined);
    }
    registered = false;
    lastStatus = undefined;
    tui = undefined;
  };

  const dispatchOpen = async (agentId: string): Promise<void> => {
    try {
      await onOpen?.(agentId);
    } catch (error) {
      if (!disposed) {
        ui?.notify(
          error instanceof Error ? error.message : String(error),
          "error",
        );
      }
    } finally {
      opening.delete(agentId);
    }
  };

  const refresh = (): void => {
    if (disposed || !ui) return;
    const agents = visible();
    if (!agents.length) {
      clear();
      return;
    }
    const running = agents.filter((agent) =>
      isWorkingStatus(agent.status),
    ).length;
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
    if (status !== lastStatus) {
      ui.setStatus(SUBAGENT_WIDGET, `Subagents: ${status}`);
      lastStatus = status;
    }
    if (!registered) {
      registered = true;
      ui.setWidget(
        SUBAGENT_WIDGET,
        (hostTui, theme) => {
          tui = hostTui;
          let hits: AgentWidgetHit[] = [];
          return {
            render: (width) => {
              const layout = layoutAgentWidget(
                visible(),
                theme,
                width,
                clock.now(),
              );
              hits = layout.hits;
              return layout.lines;
            },
            handleMouse: (event: TuiMouseEvent) => {
              if (disposed || !onOpen || event.button !== "left") return;
              const hit = hits.find(
                (item) =>
                  item.y === event.y &&
                  event.x >= item.x &&
                  event.x < item.x + item.width,
              );
              const agent =
                hit && visible().find((item) => item.id === hit.agentId);
              if (!agent || agent.status === "queued" || !nativeViewHint(agent))
                return;
              if (event.type === "press")
                return { handled: true, render: false };
              if (event.type !== "click") return;
              if (!opening.has(agent.id)) {
                opening.add(agent.id);
                void dispatchOpen(agent.id);
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
    tui?.requestRender();
    const needsTimer = agents.some(
      (agent) =>
        isDisplayActive(agent) ||
        (agent.completedAt !== undefined &&
          clock.now() - agent.completedAt < FINISHED_LINGER_MS),
    );
    if (needsTimer && !cancelTimer) {
      cancelTimer = clock.repeat(() => refresh());
    } else if (!needsTimer && cancelTimer) {
      cancelTimer();
      cancelTimer = undefined;
    }
  };

  const unsubscribe = source.subscribe(() => refresh());

  return {
    bind(nextUi) {
      if (disposed) return;
      if (nextUi !== ui) {
        clear();
        ui = nextUi;
      }
      refresh();
    },
    refresh,
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      clear();
      ui = undefined;
    },
  };
}
