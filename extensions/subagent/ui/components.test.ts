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
import type { AgentSnapshot } from "../manager.ts";
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

function headlessAgent(): AgentSnapshot {
  return {
    ...agent("headless"),
    runtime: "custom-runtime",
    terminalId: undefined,
    sessionState: "running",
    capabilities: {
      nativeClone: false,
      steer: false,
      retainedSession: true,
      concurrentNativeInput: true,
    },
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

test("views uses a single agent list and Enter immediately opens the selected view", () => {
  const source = new Source();
  source.agents = [agent("one"), agent("two")];
  const h = panel(source);
  assert.match(h.component.render(80).join("\n"), /Subagent views/);
  h.component.handleInput("\x1b[B");
  const list = h.component.render(80).join("\n");
  assert.doesNotMatch(list, /\[Agents\]|\[Actions\]|Split right|Split down/);
  h.component.handleInput("\r");
  assert.deepEqual(h.result, { agentId: "two", action: "open" });
  h.component.dispose();
  h.component.dispose();
  assert.equal(source.listeners.size, 0);
});

test("copy/delete return the full selected ID even before a terminal exists", () => {
  for (const [key, action] of [
    ["y", "copy"],
    ["d", "delete"],
  ] as const) {
    const source = new Source();
    const id = "12345678-full-subagent-id";
    source.agents = [{ ...agent(id, "queued"), terminalId: undefined }];
    const h = panel(source);
    h.component.handleInput(key);
    h.component.handleInput(key);
    assert.deepEqual(h.result, { agentId: id, action });
    assert.equal(h.completions, 1);
    h.component.dispose();
    assert.equal(source.listeners.size, 0);
  }
  const h = panel(new Source());
  h.component.handleInput("y");
  h.component.handleInput("d");
  assert.equal(h.completions, 0);
  h.component.dispose();
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
  assert.deepEqual(h.result, { agentId: "two", action: "focus" });
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

test("Enter opens a native view for a running headless Codex task", () => {
  const source = new Source();
  source.agents = [{ ...headlessAgent(), runtime: "codex" }];
  const h = panel(source);
  const rendered = h.component.render(80).join("\n");
  assert.match(rendered, /Native view available; Enter to open/);
  assert.doesNotMatch(rendered, /after completion|Native Codex/);
  h.component.handleInput("\r");
  assert.deepEqual(h.result, { agentId: "headless", action: "open" });
  h.component.dispose();
});

test("released tasks show retained results without allowing native open", () => {
  const source = new Source();
  source.agents = [
    {
      ...headlessAgent(),
      status: "completed",
      sessionState: "closed",
      terminalId: "stale-terminal",
    },
  ];
  const h = panel(source);
  assert.match(
    h.component.render(100).join("\n"),
    /Runtime released; result retained/,
  );
  h.component.handleInput("\r");
  assert.equal(h.completions, 0);
  h.component.dispose();
});

test("click opens a native view for a running headless Codex task only once", () => {
  const source = new Source();
  source.agents = [{ ...headlessAgent(), runtime: "codex" }];
  const h = panel(source);
  const lines = h.component.render(80);
  const y = lines.findLastIndex((line) => line.includes("任务 headless"));
  assert.ok(y >= 0);
  const event = { type: "click", button: "left", x: 4, y } as TuiMouseEvent;
  h.component.handleMouse(event);
  h.component.handleMouse(event);
  h.component.handleInput("\r");
  assert.deepEqual(h.result, { agentId: "headless", action: "open" });
  assert.equal(h.completions, 1);
  h.component.dispose();
});

test("native view eligibility uses capabilities and live session state, not runtime names", () => {
  const base = headlessAgent();
  assert.ok(base.capabilities);
  const cases: [Partial<AgentSnapshot>, boolean][] = [
    [{}, true],
    [{ runtime: undefined }, true],
    [{ sessionState: "idle" }, true],
    [{ sessionState: "interactive" }, true],
    [{ status: "completed", sessionState: "idle" }, true],
    [{ status: "completed", sessionState: "interactive" }, true],
    [{ status: "stopped", sessionState: "idle" }, true],
    [{ status: "error", sessionState: "idle" }, true],
    [{ status: "stopping" }, true],
    [{ viewId: "existing" }, true],
    [{ status: "queued", sessionState: "idle" }, false],
    [{ status: "starting", sessionState: "idle" }, false],
    [{ status: "disconnected", sessionState: "idle" }, false],
    [{ sessionState: "disconnected" }, false],
    [{ sessionState: "closed" }, false],
    [{ sessionState: undefined }, false],
    [{ status: "completed", sessionState: "disconnected" }, false],
    [{ status: "completed", sessionState: "closed" }, false],
    [{ status: "error", sessionState: "running" }, false],
    [{ status: "error", sessionState: "interactive" }, false],
    [{ capabilities: undefined }, false],
    [{ runtime: "codex", capabilities: undefined }, false],
    [
      {
        runtime: "codex",
        status: "completed",
        sessionState: "idle",
        capabilities: undefined,
      },
      false,
    ],
  ];
  for (const retainedSession of [false, true]) {
    for (const concurrentNativeInput of [false, true]) {
      const capabilities = {
        ...base.capabilities,
        retainedSession,
        concurrentNativeInput,
      };
      for (const sessionState of ["running", "idle", "interactive"] as const) {
        cases.push([
          { capabilities, sessionState },
          retainedSession && concurrentNativeInput,
        ]);
      }
      for (const status of ["completed", "stopped", "error"] as const) {
        cases.push([
          { capabilities, status, sessionState: "idle" },
          retainedSession,
        ]);
      }
      cases.push([
        { capabilities, status: "stopping" },
        retainedSession && concurrentNativeInput,
      ]);
      cases.push([{ capabilities, terminalId: "existing-terminal" }, true]);
    }
  }
  for (const [patch, available] of cases) {
    for (const input of ["enter", "click"]) {
      const source = new Source();
      const snapshot = { ...base, ...patch };
      source.agents = [snapshot];
      const h = panel(source);
      const lines = h.component.render(80);
      assert.equal(
        /Terminal not ready|Runtime released/.test(lines.join("\n")),
        !available,
        JSON.stringify(patch),
      );
      if (input === "enter") h.component.handleInput("\r");
      else {
        const y = lines.findLastIndex((line) => line.includes("任务 headless"));
        assert.ok(y >= 0);
        h.component.handleMouse({
          type: "click",
          button: "left",
          x: 4,
          y,
        } as TuiMouseEvent);
      }
      assert.equal(h.completions, available ? 1 : 0, JSON.stringify(patch));
      if (available) {
        assert.deepEqual(h.result, {
          agentId: snapshot.id,
          action: snapshot.viewId ? "focus" : "open",
        });
      }
      h.component.dispose();
    }
  }
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

test("clicking an agent row directly opens or focuses its view", () => {
  const source = new Source();
  source.agents = [agent(), { ...agent("two"), viewId: "existing" }];
  const h = panel(source);
  const lines = h.component.render(80);
  const click = (x: number, y: number) =>
    ({
      type: "click",
      button: "left",
      x,
      y,
    }) as TuiMouseEvent;
  const targetY = lines.findIndex((line) => line.includes("任务 two · two"));
  assert.ok(targetY >= 0);
  h.component.handleMouse(click(4, targetY));
  assert.deepEqual(h.result, { agentId: "two", action: "focus" });
  h.component.dispose();
});

test("clicking a ready agent opens immediately and completes only once", () => {
  const source = new Source();
  source.agents = [agent("one"), agent("two")];
  const h = panel(source);
  const lines = h.component.render(80);
  const y = lines.findIndex((line) => line.includes("任务 two · two"));
  const event = { type: "click", button: "left", x: 4, y } as TuiMouseEvent;
  assert.ok(y >= 0);
  assert.equal(
    h.component.handleMouse({ ...event, type: "press" })?.focus,
    true,
  );
  assert.equal(h.completions, 0);
  h.component.handleMouse(event);
  h.component.handleMouse(event);
  h.component.handleInput("\r");
  assert.deepEqual(h.result, { agentId: "two", action: "open" });
  assert.equal(h.completions, 1);
  h.component.dispose();
});

test("mouse row identity survives live reordering and ignores removed agents", () => {
  for (const removed of [false, true]) {
    const source = new Source();
    source.agents = [agent("one"), agent("two")];
    const h = panel(source);
    const lines = h.component.render(80);
    const y = lines.findIndex((line) => line.includes("任务 two · two"));
    source.update(
      removed
        ? [agent("one"), agent("replacement")]
        : [agent("two"), agent("one")],
    );
    h.component.handleMouse({
      type: "click",
      button: "left",
      x: 4,
      y,
    } as TuiMouseEvent);
    assert.equal(h.completions, removed ? 0 : 1);
    if (!removed)
      assert.deepEqual(h.result, { agentId: "two", action: "open" });
    h.component.dispose();
  }
});

test("compact panels keep the visible selected agent clickable", () => {
  for (const rows of [4, 6, 8, 10, 12]) {
    const source = new Source();
    source.agents = [agent("one"), agent("two")];
    const h = panel(source, "two", rows);
    const lines = h.component.render(80);
    const y = lines.findLastIndex((line) => line.includes("任务 two · two"));
    assert.ok(y >= 0, `Missing agent row at ${rows} terminal rows`);
    h.component.handleMouse({
      type: "click",
      button: "left",
      x: 4,
      y,
    } as TuiMouseEvent);
    assert.deepEqual(h.result, { agentId: "two", action: "open" });
    h.component.dispose();
  }
});

test("queued clicks stay in the agent list until the terminal is ready", () => {
  const source = new Source();
  source.agents = [{ ...agent("one", "queued"), terminalId: undefined }];
  const h = panel(source);
  const lines = h.component.render(80);
  const y = lines.findIndex((line) => line.includes("任务 one · one"));
  h.component.handleMouse({
    type: "click",
    button: "left",
    x: 4,
    y,
  } as TuiMouseEvent);
  assert.equal(h.completions, 0);
  source.update([agent()]);
  h.component.handleInput("\r");
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

test("expired completed tasks reappear during interaction, then return to idle without stale stats", () => {
  const source = new Source();
  const completed = {
    ...agent("manual", "completed"),
    completedAt: 1000,
    sessionState: "idle" as const,
  };
  source.agents = [completed];
  let now = 60000;
  let renderer: Component | undefined;
  const rendered = () => renderer?.render(160).join("\n") ?? "";
  let starts = 0;
  let stops = 0;
  let tick: (() => void) | undefined;
  const statuses: (string | undefined)[] = [];
  const ui = {
    setWidget(_key: string, content: unknown) {
      renderer =
        typeof content === "function"
          ? content({ requestRender() {} }, theme)
          : undefined;
    },
    setStatus(_key: string, status: string | undefined) {
      statuses.push(status);
    },
  } as unknown as ExtensionUIContext;
  const widget = new SubagentStatusWidget(source, {
    now: () => now,
    repeat(callback) {
      starts += 1;
      tick = callback;
      return () => {
        stops += 1;
      };
    },
  });
  widget.bind(ui);
  assert.equal(renderer, undefined);
  source.update([
    { ...completed, sessionState: "interactive", sessionActivity: "bash" },
  ]);
  assert.match(rendered(), /interactive/);
  assert.match(rendered(), /bash/);
  assert.doesNotMatch(rendered(), /tokens|tools/);
  assert.match(statuses.at(-1) ?? "", /0 active · 1 interactive/);
  now += 60000;
  tick?.();
  assert.ok(renderer);
  assert.equal(starts, 1);
  source.update([completed]);
  assert.equal(renderer, undefined);
  assert.equal(stops, 1);
  source.update([{ ...completed, sessionState: "disconnected" }]);
  assert.match(rendered(), /completed · disconnected/);
  assert.equal(
    starts,
    1,
    "Disconnected completed sessions must not spin forever",
  );
  widget.dispose();
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
    /Auditor · — · 任务 one/,
  );
});
