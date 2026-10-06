import assert from "node:assert/strict";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import {
  type ExtensionUIContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import {
  type Component,
  colorToHex,
  getKeybindings,
  type KeybindingsManager,
  type TUI,
  type TuiMouseEvent,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { buildYearCalendar } from "./calendar.ts";
import { addSessionEntry, createStatsSnapshot, dateKey } from "./core.ts";
import { buildStatsReport, type StatsReport } from "./report.ts";
import { StatsPanel, type StatsPanelAction, showStatsPanel } from "./tui.ts";

function testTheme(appearance: "dark" | "light" = "dark"): Theme {
  return new Theme(
    {
      accent: "#62aeef",
      success: "#50b878",
      muted: "#888888",
      dim: "#666666",
      text: appearance === "dark" ? "#eeeeee" : "#222222",
      thinkingXhigh: "#888888",
    } as ConstructorParameters<typeof Theme>[0],
    {
      selectedBg: "#244466",
      userMessageBg: "#222222",
      customMessageBg: "#222222",
      toolPendingBg: "#222222",
      toolErrorBg: "#442222",
      toolSuccessBg: appearance === "dark" ? "#15271c" : "#e4f2e8",
    },
    "truecolor",
    { appearance },
  );
}

const theme = testTheme();

function reportFor(now = new Date(2024, 1, 29, 12)): StatsReport {
  const snapshot = createStatsSnapshot();
  for (const [date, tokens] of [
    [new Date(2024, 0, 31, 23, 59), 11],
    [new Date(2024, 1, 1, 0, 1), 23],
    [new Date(2024, 1, 29, 12), 37],
    [new Date(2024, 2, 1, 0, 1), 41],
    [new Date(2023, 1, 28, 12), 43],
  ] as const) {
    addSessionEntry(snapshot, {
      type: "message",
      timestamp: date.getTime(),
      message: {
        role: "assistant",
        provider: "p",
        model: "m",
        usage: { input: tokens, cost: { total: tokens / 100 } },
      },
    });
  }
  return buildStatsReport(snapshot, now);
}

function driver(
  rows = 24,
  report = reportFor(),
  keys = getKeybindings(),
  renderTheme = theme,
) {
  const results: StatsPanelAction[] = [];
  let renders = 0;
  const tui = {
    terminal: { rows },
    requestRender: () => renders++,
  } as unknown as TUI;
  const panel = new StatsPanel(tui, renderTheme, keys, report, (result) => {
    results.push(result);
  });
  return {
    panel,
    results,
    tui,
    get renders() {
      return renders;
    },
    render: (width = 80) => panel.render(width).map(stripVTControlCharacters),
  };
}

function mouse(x: number, y: number, type: TuiMouseEvent["type"] = "click") {
  return {
    type,
    button: "left",
    x,
    y,
    screenX: x,
    screenY: y,
    width: 80,
    height: 24,
    shift: false,
    ctrl: false,
    alt: false,
  } satisfies TuiMouseEvent;
}

test("annual grid covers leap days and 53/54 boundary weeks exactly once", () => {
  const report = reportFor();
  for (const [year, days, weeks] of [
    [2023, 365, 53],
    [2024, 366, 53],
    [2000, 366, 54],
    [1900, 365, 53],
  ]) {
    const grid = buildYearCalendar(report.calendar, year);
    assert.equal(grid.days.length, days);
    assert.equal(grid.weeks.length, weeks);
    assert.equal(new Set(grid.days.map((day) => day.key)).size, days);
    assert.ok(grid.weeks.every((week) => week.length === 7));
    for (const day of grid.days) {
      assert.equal(grid.weeks[day.week][day.weekday], day);
    }
  }
  const leap = buildYearCalendar(report.calendar, 2024);
  const feb29 = leap.days.find((day) => day.key === "2024-02-29");
  assert.equal(feb29?.tokens, 37);
  assert.equal(feb29?.cost, 0.37);
  assert.equal(feb29?.weekday, 4);
  assert.equal(feb29?.level, 4);
  assert.equal(leap.days.find((day) => day.key === "2024-01-01")?.level, 0);
  for (const invalid of [0, -1, 10000, 2024.5, Number.NaN]) {
    assert.throws(
      () => buildYearCalendar(report.calendar, invalid),
      RangeError,
    );
  }
});

const weekday = /^ [日一二三四五六] /;

test("compact highlighted summary comes from the report, not the selected year", () => {
  const report = reportFor(new Date(2024, 1, 1, 0, 1));
  assert.equal(
    report.calendar.today,
    dateKey(new Date(2024, 1, 1, 0, 1).getTime()),
  );
  const h = driver(24, report);
  const lines = h.render();
  for (const label of ["今日 23", "本月 60", "累计 155"]) {
    assert.ok(lines[0].includes(label));
  }
  assert.ok(!lines[0].includes("$"));
  assert.ok(h.panel.render(80)[0].includes("\u001b[1m"));
  h.panel.handleInput("[");
  assert.ok(h.render()[1].includes("‹ 2023 ›"));
  assert.equal(h.render()[0], lines[0]);
  h.panel.handleInput("]");
  assert.ok(h.render()[1].includes("2024-02-01"));
});

test("layouts cap at 15 half-screen rows and fit even tiny docks", () => {
  for (const rows of [0, 1, 2, 3, 4, 6, 8, 10, 12, 18, 24, 32, 50, 52, 80]) {
    for (const width of [0, 1, 2, 3, 4, 5, 10, 20, 40, 59, 80, 110, 120]) {
      const h = driver(rows);
      const lines = h.render(width);
      assert.equal(
        lines.length,
        width ? Math.min(15, Math.max(1, Math.floor(rows / 2))) : 0,
      );
      for (const line of lines) {
        assert.equal(
          visibleWidth(line),
          width,
          `${rows} rows, ${width} columns`,
        );
      }
      h.panel.handleInput("\x1b[C");
      for (const line of h.render(width))
        assert.equal(visibleWidth(line), width);
    }
  }
});

test("24×120 shows all seven weekdays and aligned months for 53/54 weeks", () => {
  for (const year of [2024, 2000]) {
    const h = driver(24, reportFor(new Date(year, 6, 1, 12)));
    const lines = h.render(120);
    assert.equal(lines.filter((line) => weekday.test(line)).length, 7);
    assert.ok(!lines[1].includes("W"));
    const months = lines[2];
    const grid = buildYearCalendar(reportFor().calendar, year);
    for (const day of grid.days.filter((day) => day.date === 1)) {
      const x = 4 + day.week * 2;
      assert.equal(
        visibleWidth(months.slice(0, months.indexOf(`${day.month + 1}月`))),
        x,
      );
    }
    assert.ok(!lines.join("").match(/[░▒▓█]/));
  }
});

test("heatmap cells keep fixed spacing across widths and viewport pans", () => {
  const h = driver(32, reportFor(new Date(2024, 0, 1, 12)));
  for (const width of [12, 20, 24, 40, 80, 100, 110, 120, 160]) {
    for (let pass = 0; pass < 2; pass++) {
      const lines = h.render(width);
      for (const line of lines.filter((value) => weekday.test(value))) {
        const columns = [...line.matchAll(/[■◆]/g)].map((match) =>
          visibleWidth(line.slice(0, match.index)),
        );
        for (let index = 1; index < columns.length; index++) {
          assert.equal(columns[index] - columns[index - 1], 2);
        }
      }
      for (let index = 0; index < 20; index++) h.panel.handleInput("\x1b[C");
    }
  }
});

test("colored cells use distinct success shades and an accent selected day", () => {
  for (const name of ["dark", "light"]) {
    const activeTheme = testTheme(name as "dark" | "light");
    const shades = new Set<string>();
    let selected = false;
    const recording = new Proxy(activeTheme, {
      get(target, property) {
        if (property === "style") {
          return (value: string, options: Parameters<Theme["style"]>[1]) => {
            if (options.fg && typeof options.fg !== "string") {
              if (value.includes("◆")) {
                selected = true;
                assert.equal(
                  colorToHex(options.fg),
                  colorToHex(target.colors.accent),
                );
                assert.equal(options.bold, true);
              } else {
                shades.add(colorToHex(options.fg));
              }
            }
            return target.style(value, options);
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const h = driver(24, reportFor(), getKeybindings(), recording);
    const raw = h.panel.render(80);
    assert.ok(raw.some((line) => line.includes("\u001b[38;")));
    assert.ok(shades.size >= 4);
    assert.ok(selected);
    assert.equal(h.render().join("").split("◆").length - 1, 1);
  }
});

test("million-token summary stays compact with seven weekdays at 24×80", () => {
  const report = reportFor();
  report.calendar.todayTokens = 101_234_567;
  report.calendar.monthTokens = 101_234_567;
  report.total.totalTokens = 101_234_567;
  const h = driver(24, report);
  const lines = h.render();
  assert.equal(lines.length, 12);
  for (const label of ["今日", "本月", "累计"]) {
    assert.ok(lines[0].includes(`${label} 101.2M`));
  }
  assert.equal(lines.filter((line) => weekday.test(line)).length, 7);
});

test("narrow heatmap pans with arrows and keeps selected day visible", () => {
  const h = driver(32, reportFor(new Date(2024, 0, 1, 12)));
  assert.ok(h.render(24).some((line) => line.includes("W1–10/53")));
  for (let i = 0; i < 30; i++) h.panel.handleInput("\x1b[C");
  const panned = h.render(24);
  assert.ok(panned.some((line) => line.includes("W22–31/53")));
  assert.equal(panned.join("").split("◆").length - 1, 1);
  for (let i = 0; i < 60; i++) h.panel.handleInput("\x1b[D");
  assert.ok(h.render(24).some((line) => line.includes("W1–10/53")));
  assert.ok(h.render(80).some((line) => line.includes("2024-01-01")));
});

test("year keys and exact local chevron clicks clamp leap days", () => {
  const h = driver();
  assert.ok(h.render()[1].includes("2024-02-29: 37 tokens"));
  h.panel.handleInput("\x1b[5~");
  assert.ok(h.render()[1].includes("2023-02-28: 43 tokens"));
  h.panel.handleInput("\x1b[6~");
  assert.ok(h.render()[1].includes("2024-02-28"));
  assert.equal(h.panel.handleMouse(mouse(0, 1)), undefined);
  assert.equal(h.panel.handleMouse(mouse(2, 1)), undefined);
  assert.deepEqual(h.panel.handleMouse(mouse(1, 1, "press")), {
    handled: true,
    focus: true,
  });
  h.panel.handleMouse(mouse(1, 1));
  assert.ok(h.render()[1].includes("2023-02-28"));
  h.panel.handleMouse(mouse(8, 1));
  assert.ok(h.render()[1].includes("2024-02-28"));
  h.panel.handleInput("\x1b[B");
  assert.ok(h.render()[1].includes("2024-02-29"));
  h.panel.handleInput("\x1b[A");
  assert.ok(h.render()[1].includes("2024-02-28"));
});

test("heatmap clicks match painted cells, not gaps or partial weeks", () => {
  for (const width of [80, 120]) {
    const h = driver(32);
    const lines = h.render(width);
    const monday = lines.findIndex((line) => line.startsWith(" 一 "));
    const sunday = lines.findIndex((line) => line.startsWith(" 日 "));
    assert.equal(h.panel.handleMouse(mouse(4, sunday)), undefined);
    assert.equal(h.panel.handleMouse(mouse(5, monday)), undefined);
    h.panel.handleMouse(mouse(4, monday));
    assert.ok(
      h.render(width).some((line) => line.includes("2024-01-01: 0 tokens")),
    );
    assert.equal(h.results.length, 0);
    assert.equal(h.panel.handleMouse(mouse(width, monday)), undefined);
  }
});

test("details clicks match pinned local width-clipped button bounds", () => {
  for (const rows of [4, 6, 8, 24, 32, 52]) {
    for (const width of [1, 2, 10, 80]) {
      const h = driver(rows);
      const lines = h.render(width);
      const y = lines.findLastIndex((line) => line.trimStart().startsWith("["));
      assert.ok(y >= 0);
      const x = width >= 12 ? 1 : 0;
      const bound =
        x + visibleWidth(truncateToWidth("[查看详情]", width - x, ""));
      assert.equal(h.panel.handleMouse(mouse(x - 1, y)), undefined);
      assert.equal(h.panel.handleMouse(mouse(bound, y)), undefined);
      assert.equal(
        h.panel.handleMouse({ ...mouse(x, y), button: "right" }),
        undefined,
      );
      assert.deepEqual(h.panel.handleMouse(mouse(bound - 1, y, "press")), {
        handled: true,
        focus: true,
      });
      assert.deepEqual(h.results, []);
      assert.deepEqual(h.panel.handleMouse(mouse(bound - 1, y)), {
        handled: true,
        focus: false,
      });
      h.panel.handleInput("\r");
      h.panel.cancel();
      assert.deepEqual(h.results, ["details"]);
    }
  }
});

test("Enter activates details, Escape cancels, configured Pi keys work", () => {
  for (const input of ["\r", "\x1b[13u"]) {
    const h = driver(2);
    h.panel.handleInput(input);
    assert.deepEqual(h.results, ["details"]);
  }
  const h = driver(2);
  h.panel.handleInput("\x1b");
  h.panel.handleInput("\r");
  assert.deepEqual(h.results, [undefined]);
  const configured = {
    matches: (data: string, action: string) =>
      data === "configured" && action === "tui.select.confirm",
  } as KeybindingsManager;
  const custom = driver(24, reportFor(), configured);
  custom.panel.handleInput("configured");
  assert.deepEqual(custom.results, ["details"]);
});

test("usage calculation runs once per visited year, not per render", () => {
  const report = reportFor();
  let reads = 0;
  report.calendar.byDate = new Proxy(report.calendar.byDate, {
    get(target, key, receiver) {
      reads++;
      return Reflect.get(target, key, receiver);
    },
  });
  const h = driver(24, report);
  assert.equal(reads, 366);
  h.render();
  h.render(20);
  h.panel.invalidate();
  h.render();
  assert.equal(reads, 366);
  h.panel.handleInput("[");
  assert.equal(reads, 366 + 365);
  h.panel.handleInput("]");
  h.render();
  assert.equal(reads, 366 + 365);
});

test("resize/invalidation clears stale hits and theme is evaluated each render", () => {
  let palette = "first";
  const colored = new Proxy(theme, {
    get(target, property) {
      if (property === "fg")
        return (_color: string, value: string) => `${palette}:${value}`;
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const h = driver(24, reportFor(), getKeybindings(), colored);
  assert.ok(h.render()[0].includes("first:"));
  palette = "second";
  h.panel.invalidate();
  assert.equal(h.panel.handleMouse(mouse(0, 10)), undefined);
  assert.ok(h.render()[0].includes("second:"));
  h.render(0);
  assert.equal(h.panel.handleMouse(mouse(0, 10)), undefined);
  h.panel.dispose();
  h.panel.dispose();
  h.panel.handleInput("\r");
  assert.deepEqual(h.results, []);
});

test("showStatsPanel docks without overlay and resolves after host cleanup", async () => {
  let disposals = 0;
  let component: (Component & { dispose?: () => void }) | undefined;
  const ui = {
    custom: async <T>(
      factory: Parameters<ExtensionUIContext["custom"]>[0],
      options: Parameters<ExtensionUIContext["custom"]>[1],
    ) => {
      assert.equal(options, undefined);
      return new Promise<T>((resolve) => {
        const h = driver();
        const keys = getKeybindings() as Parameters<typeof factory>[2];
        const value = factory(h.tui, theme, keys, (result) => {
          component?.dispose?.();
          resolve(result as T);
        });
        assert.ok(!(value instanceof Promise));
        component = value;
        assert.ok(component.dispose);
        const dispose = component.dispose.bind(component);
        component.dispose = () => {
          disposals++;
          dispose();
        };
        component.handleInput?.("\r");
      });
    },
  } as Pick<ExtensionUIContext, "custom">;
  assert.equal(await showStatsPanel(ui, reportFor()), "details");
  assert.ok(disposals >= 1);
});
