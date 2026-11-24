import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  ExtensionUIContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import {
  type Component,
  getKeybindings,
  type TUI,
  visibleWidth,
} from "@earendil-works/pi-tui";
import type { AgentSnapshot } from "../manager.ts";
import type { AgentSource } from "./presentation.ts";
import { createSubagentStatusWidget } from "./status-widget.ts";
import {
  createSubagentViewsPanel,
  showSubagentViews,
  type ViewActionResult,
  type ViewChoice,
  type ViewPanelResult,
} from "./views.ts";

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  underline: (text: string) => text,
} as Theme;

function createSource(): AgentSource & {
  agents: AgentSnapshot[];
  listeners: Set<() => void>;
  update(agents: AgentSnapshot[]): void;
} {
  const listeners = new Set<() => void>();
  return {
    agents: [],
    listeners,
    list() {
      return this.agents;
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    update(agents: AgentSnapshot[]) {
      this.agents = agents;
      for (const listener of listeners) listener();
    },
  };
}

function agent(
  id = "sub-1",
  status: AgentSnapshot["status"] = "running",
): AgentSnapshot {
  return {
    id,
    description: `任务 ${id}`,
    status,
    supportsView: true,
    terminalId: `terminal-${id}`,
    startedAt: 1_000,
  };
}

function panel(
  source: ReturnType<typeof createSource>,
  initialId?: string,
  rows = 24,
  onAction: (
    choice: ViewChoice,
  ) => Promise<ViewActionResult> = async () => ({}),
) {
  let result: ViewPanelResult | undefined;
  let completions = 0;
  let renders = 0;
  const tui = {
    terminal: { rows },
    requestRender() {
      renders += 1;
    },
  } as unknown as TUI;
  const component = createSubagentViewsPanel(
    tui,
    theme,
    getKeybindings(),
    source,
    (choice) => {
      result = choice;
      completions += 1;
    },
    onAction,
    initialId,
  );
  return {
    component,
    get result() {
      return result?.choice;
    },
    get panelResult() {
      return result;
    },
    get completions() {
      return completions;
    },
    get renders() {
      return renders;
    },
  };
}

test("views uses a single agent list and Enter opens the selected view when available", async () => {
  const source = createSource();
  source.agents = [agent("sub-1"), agent("sub-2")];
  const actions: ViewChoice[] = [];
  const h = panel(source, undefined, 24, async (choice) => {
    actions.push(choice);
    return { closePanel: true };
  });
  assert.match(h.component.render(80).join("\n"), /Subagent views/);
  h.component.handleInput("\x1b[B");
  h.component.handleInput("\r");
  await Promise.resolve();
  assert.deepEqual(actions, [{ agentId: "sub-2", action: "open" }]);
  assert.deepEqual(h.result, { agentId: "sub-2", action: "open" });
  h.component.dispose();
  assert.equal(source.listeners.size, 0);
});

test("headless subprocess and released sessions explain view status and block native open", () => {
  const source = createSource();
  source.agents = [
    { ...agent("sub-1"), supportsView: false, terminalId: undefined },
  ];
  const h1 = panel(source);
  assert.match(h1.component.render(100).join("\n"), /Headless subprocess mode/);
  h1.component.handleInput("\r");
  assert.equal(h1.completions, 0);
  h1.component.dispose();

  source.agents = [
    {
      ...agent("sub-2", "completed"),
      sessionState: "closed",
      terminalId: undefined,
    },
  ];
  const h2 = panel(source);
  assert.match(
    h2.component.render(100).join("\n"),
    /Process released; result and session file retained for resume/,
  );
  h2.component.handleInput("\r");
  assert.equal(h2.completions, 0);
  h2.component.dispose();
});

test("copy, stop, and delete shortcuts operate on selected agent", async () => {
  const source = createSource();
  source.agents = [agent("sub-1"), agent("sub-2")];
  const actions: ViewChoice[] = [];
  const h = panel(source, "sub-2", 24, async (choice) => {
    actions.push(choice);
    return {};
  });
  h.component.handleInput("s");
  await Promise.resolve();
  assert.deepEqual(actions, [{ agentId: "sub-2", action: "stop" }]);

  h.component.handleInput("d");
  assert.match(h.component.render(100).join("\n"), /Enter confirm/);
  h.component.handleInput("\r");
  await Promise.resolve();
  assert.deepEqual(actions.at(-1), { agentId: "sub-2", action: "delete" });
  h.component.dispose();
});

test("docked panel is half-height and width safe at narrow/short sizes", () => {
  const source = createSource();
  source.agents = [
    {
      ...agent(),
      description: "中文🙂".repeat(50),
      sessionActivity: "Waiting\n\x1b[31m",
    },
  ];
  for (const rows of [2, 4, 6, 10, 14, 24]) {
    const h = panel(source, undefined, rows);
    for (const width of [1, 3, 8, 20, 80]) {
      const lines = h.component.render(width);
      assert.equal(lines.length, Math.max(1, Math.floor(rows / 2)));
      assert.ok(lines.every((line) => visibleWidth(line) <= width));
    }
    h.component.dispose();
  }
});

test("showSubagentViews distinguishes cancellation from an executed action", async () => {
  for (const [input, status] of [
    ["\x1b", "cancelled"],
    ["\r", "completed"],
  ]) {
    const source = createSource();
    source.agents = [agent()];
    const events: string[] = [];
    const ui = {
      custom<T>(factory: Parameters<ExtensionUIContext["custom"]>[0]) {
        return new Promise<T>((resolve) => {
          const component = factory(
            { terminal: { rows: 24 }, requestRender() {} } as unknown as TUI,
            theme,
            getKeybindings() as Parameters<typeof factory>[2],
            resolve as (value: unknown) => void,
          ) as Component;
          queueMicrotask(() => component.handleInput?.(input));
        });
      },
    } as Pick<ExtensionUIContext, "custom">;
    const result = await showSubagentViews(
      ui,
      source,
      async () => ({ closePanel: true }),
      undefined,
      {
        onOpen: () => events.push("opened"),
        onClosed: (s) => events.push(s),
      },
    );
    assert.deepEqual(
      result,
      status === "completed"
        ? { choice: { agentId: "sub-1", action: "open" } }
        : undefined,
    );
    assert.deepEqual(events, ["opened", status]);
  }
});

test("status widget stays above editor while working and expires completed rows", () => {
  const source = createSource();
  let now = 2_000;
  let renderer: Component | undefined;
  const statuses: (string | undefined)[] = [];
  const ui = {
    setWidget(_key: string, content: unknown, options: { placement: string }) {
      if (typeof content === "function") {
        assert.equal(options.placement, "aboveEditor");
        renderer = content({ requestRender() {} }, theme);
      } else renderer = undefined;
    },
    setStatus(_key: string, text: string | undefined) {
      statuses.push(text);
    },
  } as unknown as ExtensionUIContext;
  const widget = createSubagentStatusWidget(source, {
    now: () => now,
    repeat: () => () => {},
  });
  widget.bind(ui);
  source.update([
    agent("sub-1", "running"),
    {
      ...agent("sub-2", "completed"),
      sessionState: "interactive",
      sessionActivity: "Waiting for permission",
    },
  ]);
  assert.ok(renderer);
  const rendered = renderer.render(120).join("\n");
  assert.match(rendered, /sub-1 · running · 1\.0s/);
  assert.match(
    rendered,
    /sub-2 · completed · interactive · Waiting for permission/,
  );
  assert.equal(statuses.at(-1), "Subagents: 1 active · 1 interactive");
  source.update([{ ...agent("sub-1", "completed"), completedAt: 2_000 }]);
  now = 8_000;
  widget.refresh();
  assert.equal(renderer, undefined);
  widget.dispose();
});
