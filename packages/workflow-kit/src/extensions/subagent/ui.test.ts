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
  type TuiMouseEvent,
  visibleWidth,
} from "@earendil-works/pi-tui";
import type { AgentSnapshot } from "./manager.ts";
import {
  type AgentSource,
  agentStats,
  oneLine,
  renderAgentWidget,
} from "./presentation.ts";
import { SubagentStatusWidget } from "./status-widget.ts";
import {
  SubagentViewsPanel,
  showSubagentViews,
  type ViewChoice,
} from "./views.ts";

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  underline: (text: string) => text,
} as Theme;

class Source implements AgentSource {
  agents: AgentSnapshot[] = [];
  listeners = new Set<() => void>();
  list() {
    return this.agents;
  }
  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  update(agents: AgentSnapshot[]) {
    this.agents = agents;
    for (const listener of this.listeners) listener();
  }
}

function agent(
  id = "one",
  status: AgentSnapshot["status"] = "running",
): AgentSnapshot {
  return {
    id,
    description: `任务 ${id}`,
    status,
    terminalId: `terminal-${id}`,
    startedAt: 1_000,
    turnCount: 3,
    toolUses: 2,
    totalTokens: 1234,
    activity: "read",
  };
}

function panel(source: Source, initialId?: string, rows = 24) {
  let result: ViewChoice | undefined;
  let completions = 0;
  let renders = 0;
  const tui = {
    terminal: { rows },
    requestRender() {
      renders += 1;
    },
  } as unknown as TUI;
  const component = new SubagentViewsPanel(
    tui,
    theme,
    getKeybindings(),
    source,
    (choice) => {
      result = choice;
      completions += 1;
    },
    initialId,
  );
  return {
    component,
    get result() {
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

test("views uses shared docked frame and automatic open action without direction choices", () => {
  const source = new Source();
  source.agents = [agent("one"), agent("two")];
  const h = panel(source);
  assert.match(h.component.render(80).join("\n"), /Subagent views/);
  h.component.handleInput("\x1b[B");
  h.component.handleInput("\r");
  const actions = h.component.render(80).join("\n");
  assert.match(actions, /Open view/);
  assert.doesNotMatch(actions, /Split right|Split down/);
  h.component.handleInput("\r");
  assert.deepEqual(h.result, { agentId: "two", action: "open" });
  h.component.dispose();
  h.component.dispose();
  assert.equal(source.listeners.size, 0);
});

test("view menu updates live and preserves selection by agent identity", () => {
  const source = new Source();
  source.agents = [agent("one"), agent("two")];
  const h = panel(source);
  h.component.handleInput("\x1b[B");
  source.update([
    agent("new"),
    agent("one"),
    { ...agent("two"), viewId: "view" },
  ]);
  assert.equal(h.renders, 2);
  h.component.handleInput("\r");
  h.component.render(80);
  h.component.handleInput("\x1b[B");
  h.component.handleInput("\x1b[B");
  h.component.handleInput("\x1b[B");
  h.component.handleInput("\r");
  assert.deepEqual(h.result, { agentId: "two", action: "close" });
  h.component.dispose();
});

test("queued terminal actions are unavailable, cancel never stops a worker", () => {
  const source = new Source();
  source.agents = [{ ...agent("one", "queued"), terminalId: undefined }];
  const h = panel(source, "one");
  assert.match(h.component.render(80).join("\n"), /Terminal not ready/);
  h.component.handleInput("\r");
  assert.equal(h.completions, 0);
  h.component.handleInput("\x1b");
  assert.equal(h.completions, 1);
  assert.equal(h.result, undefined);
  h.component.dispose();
  source.update([]);
  assert.equal(h.completions, 1);
});

test("docked panel is half-height and width safe at narrow/short sizes", () => {
  const source = new Source();
  source.agents = [
    {
      ...agent(),
      description: "中文🙂".repeat(50),
      activity: "read\n\x1b[31m",
    },
  ];
  for (const rows of [2, 4, 6, 10, 14, 24, 50]) {
    const h = panel(source, undefined, rows);
    for (const width of [1, 3, 8, 20, 80]) {
      const lines = h.component.render(width);
      assert.equal(lines.length, Math.max(1, Math.floor(rows / 2)));
      assert.ok(lines.every((line) => visibleWidth(line) <= width));
    }
    assert.deepEqual(h.component.render(0), []);
    h.component.dispose();
  }
});

test("mouse selects tabs and action rows using component-local coordinates", () => {
  const source = new Source();
  source.agents = [agent()];
  const h = panel(source);
  const lines = h.component.render(80);
  const actionsX = lines[1].indexOf("[Actions]");
  const click = (x: number, y: number) =>
    ({
      type: "click",
      button: "left",
      x,
      y,
    }) as TuiMouseEvent;
  h.component.handleMouse(click(actionsX + 1, 1));
  const actions = h.component.render(80);
  const openY = actions.findIndex((line) => line.includes("Open view"));
  h.component.handleMouse(click(4, openY));
  assert.deepEqual(h.result, { agentId: "one", action: "open" });
  h.component.dispose();
});

test("showSubagentViews uses shared session cleanup and cancellation lifecycle", async () => {
  const source = new Source();
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
        queueMicrotask(() => component.handleInput?.("\x1b"));
      });
    },
  } as Pick<ExtensionUIContext, "custom">;
  const result = await showSubagentViews(ui, source, undefined, {
    onOpen: () => events.push("opened"),
    onClosed: (status) => events.push(status),
  });
  assert.equal(result, undefined);
  assert.deepEqual(events, ["opened", "cancelled"]);
  assert.equal(source.listeners.size, 0);
});

test("status widget stays above editor while working and expires completed rows", () => {
  const source = new Source();
  let now = 2_000;
  let tick: (() => void) | undefined;
  let timers = 0;
  let stops = 0;
  let registrations = 0;
  let renderer: Component | undefined;
  const statuses: (string | undefined)[] = [];
  const ui = {
    setWidget(_key: string, content: unknown, options: { placement: string }) {
      if (typeof content === "function") {
        registrations += 1;
        assert.equal(options.placement, "aboveEditor");
        renderer = content({ requestRender() {} }, theme);
      } else renderer = undefined;
    },
    setStatus(_key: string, text: string | undefined) {
      statuses.push(text);
    },
  } as unknown as ExtensionUIContext;
  const widget = new SubagentStatusWidget(source, {
    now: () => now,
    repeat(callback) {
      tick = callback;
      timers += 1;
      return () => {
        stops += 1;
      };
    },
  });
  widget.bind(ui);
  assert.equal(timers, 0);
  source.update([agent(), agent("queued", "queued")]);
  assert.equal(registrations, 1);
  assert.equal(timers, 1);
  assert.match(renderer?.render(120).join("\n") ?? "", /1 queued/);
  now += 60_000;
  tick?.();
  assert.equal(
    registrations,
    1,
    "Do not replace the persistent widget each tick",
  );
  assert.match(renderer?.render(120).join("\n") ?? "", /1m1s/);
  source.update([{ ...agent("one", "completed"), completedAt: now }]);
  assert.match(renderer?.render(120).join("\n") ?? "", /completed/);
  now += 5_001;
  tick?.();
  assert.equal(renderer, undefined);
  assert.equal(stops, 1);
  assert.equal(statuses.at(-1), undefined);
  widget.dispose();
  widget.dispose();
  assert.equal(source.listeners.size, 0);
});

test("queued/disconnected widgets need no timer; disposing active UI stops updates", () => {
  const source = new Source();
  source.agents = [agent("queued", "queued")];
  let starts = 0;
  let stops = 0;
  const calls: unknown[] = [];
  const ui = {
    setWidget: (...args: unknown[]) => calls.push(args),
    setStatus: (...args: unknown[]) => calls.push(args),
  } as unknown as ExtensionUIContext;
  const widget = new SubagentStatusWidget(source, {
    now: () => 2_000,
    repeat() {
      starts += 1;
      return () => {
        stops += 1;
      };
    },
  });
  widget.bind(ui);
  assert.equal(starts, 0);
  source.update([agent("lost", "disconnected")]);
  assert.equal(starts, 0);
  source.update([agent()]);
  assert.equal(starts, 1);
  widget.dispose();
  assert.equal(stops, 1);
  assert.equal(source.listeners.size, 0);
  const before = calls.length;
  source.update([agent("another")]);
  widget.bind(ui);
  assert.equal(calls.length, before);
  // The production clock constructor is safe and remains lazy without a UI.
  const headless = new SubagentStatusWidget(source);
  headless.dispose();
});

test("widget text strips terminal sequences and line/control separators", () => {
  assert.equal(oneLine("\x1b[31mred\x1b[0m\nnew\u2028line"), "red new line");
  assert.equal(oneLine("\x1b]52;c;payload\x07safe\x00text"), "safe text");
});

test("widget tree is bounded, unicode-safe, themed and renders truthful counters", () => {
  const agents = [
    ...Array.from({ length: 10 }, (_, index) => ({
      ...agent(`${index}`),
      description: "读代码🙂".repeat(50),
    })),
    agent("queued", "queued"),
    { ...agent("done", "completed"), contextPercent: 80, compactionCount: 2 },
  ];
  for (const width of [1, 4, 10, 80, 200]) {
    const lines = renderAgentWidget(agents, theme, width, 2_000);
    assert.ok(lines.length <= 12);
    assert.ok(lines.every((line) => visibleWidth(line) <= width));
  }
  const last = agents.at(-1);
  assert.ok(last);
  assert.match(
    agentStats(last, 2_000),
    /⟳3 · 2 tools · 1.2k tokens \(80% · ↻2\)/,
  );
  assert.deepEqual(renderAgentWidget([], theme, 80), []);
  const named = { ...agent(), subagentType: "review", displayName: "Auditor" };
  assert.match(
    renderAgentWidget([named], theme, 200, 2_000).join("\n"),
    /Auditor · 任务 one/,
  );
});
