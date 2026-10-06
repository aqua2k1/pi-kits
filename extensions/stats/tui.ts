import type {
  ExtensionUIContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import {
  Key,
  type KeybindingsManager,
  matchesKey,
  mixColors,
  type TUI,
  type TuiMouseEvent,
  type TuiMouseEventResult,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { DockedPanelFrame } from "../../shared/ui/docked-panel/frame.ts";
import { dockedPanelLayout } from "../../shared/ui/docked-panel/layout.ts";
import { runDockedPanel } from "../../shared/ui/docked-panel/session.ts";
import {
  buildYearCalendar,
  type CalendarDay,
  type YearCalendar,
} from "./calendar.ts";
import type { StatsReport } from "./report.ts";

export type StatsPanelAction = "details" | undefined;

function tokenLabel(tokens: number): string {
  return `${tokens.toLocaleString("en-US")} tokens`;
}

function compactTokens(tokens: number): string {
  return tokens.toLocaleString("en-US", {
    notation: "compact",
    maximumFractionDigits: 1,
  });
}

interface Hit {
  x: number;
  y: number;
  width: number;
  activate: () => void;
}

/** UI state only: summaries come from the shared report, annual grids are cached. */
export class StatsPanel {
  private selected: CalendarDay;
  private calendar: YearCalendar;
  private readonly calendars = new Map<number, YearCalendar>();
  private weekStart = 0;
  private hits: Hit[] = [];
  private finished = false;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly keys: KeybindingsManager,
    private readonly report: StatsReport,
    private readonly done: (action: StatsPanelAction) => void,
  ) {
    const year = new Date(report.generatedAt).getFullYear();
    this.calendar = this.getCalendar(year);
    this.selected =
      this.calendar.days.find((day) => day.key === report.calendar.today) ??
      this.calendar.days[0];
  }

  private getCalendar(year: number): YearCalendar {
    let calendar = this.calendars.get(year);
    if (!calendar) {
      calendar = buildYearCalendar(this.report.calendar, year);
      this.calendars.set(year, calendar);
    }
    return calendar;
  }

  cancel(): void {
    this.finish(undefined);
  }

  dispose(): void {
    this.finished = true;
    this.hits = [];
    this.calendars.clear();
  }

  invalidate(): void {
    this.hits = [];
  }

  private finish(action: StatsPanelAction): void {
    if (this.finished) return;
    this.finished = true;
    this.hits = [];
    this.done(action);
  }

  private changed(): void {
    this.invalidate();
    this.tui.requestRender();
  }

  private changeYear(delta: number): void {
    const year = Math.max(1, Math.min(9999, this.calendar.year + delta));
    this.calendar = this.getCalendar(year);
    // Preserve month/day; February 29 clamps to February 28 in ordinary years.
    const month = this.calendar.days.filter(
      (day) => day.month === this.selected.month,
    );
    this.selected =
      month.find((day) => day.date === this.selected.date) ??
      month[month.length - 1];
    this.weekStart = 0;
    this.changed();
  }

  private move(days: number): void {
    const index = Math.max(
      0,
      Math.min(this.calendar.days.length - 1, this.selected.index + days),
    );
    this.selected = this.calendar.days[index];
    this.changed();
  }

  handleInput(data: string): void {
    if (this.finished) return;
    if (
      matchesKey(data, Key.escape) ||
      this.keys.matches(data, "tui.select.cancel")
    ) {
      this.cancel();
    } else if (
      matchesKey(data, Key.enter) ||
      this.keys.matches(data, "tui.select.confirm")
    ) {
      this.finish("details");
    } else if (data === "[" || this.keys.matches(data, "tui.select.pageUp")) {
      this.changeYear(-1);
    } else if (data === "]" || this.keys.matches(data, "tui.select.pageDown")) {
      this.changeYear(1);
    } else if (matchesKey(data, Key.left)) {
      this.move(-7);
    } else if (matchesKey(data, Key.right)) {
      this.move(7);
    } else if (this.keys.matches(data, "tui.select.up")) {
      this.move(-1);
    } else if (this.keys.matches(data, "tui.select.down")) {
      this.move(1);
    }
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (this.finished || event.button !== "left") return;
    const hit = this.hits.find(
      (item) =>
        event.y === item.y &&
        event.x >= item.x &&
        event.x < item.x + item.width,
    );
    if (!hit) return;
    if (event.type === "press") return { handled: true, focus: true };
    if (event.type !== "click") return;
    hit.activate();
    return { handled: true, focus: !this.finished };
  }

  render(width: number): string[] {
    this.hits = [];
    if (width < 1) return [];
    const base = dockedPanelLayout(this.tui.terminal.rows);
    const rows = Math.min(base.rows, 15);
    const layout = {
      ...base,
      rows,
      showTabs: false,
      showHints: rows >= 15,
      pinnedLines: rows >= 15 ? 3 : 2,
    };
    const summary = [
      ["今日", this.report.calendar.todayTokens],
      ["本月", this.report.calendar.monthTokens],
      ["累计", this.report.total.totalTokens],
    ] as const;
    const title = summary
      .map(
        ([label, tokens]) =>
          `${this.theme.fg("muted", label)} ${this.theme.style(compactTokens(tokens), { fg: "accent", bold: true })}`,
      )
      .join("   ");
    const frame = new DockedPanelFrame(layout, width, this.theme, title);
    const lines = frame.heading([], 0);
    const controls = rows >= 2 ? 1 : 0;
    const budget =
      rows -
      lines.length -
      Number(rows >= 3) -
      controls -
      Number(layout.showHints);
    if (budget > 0) this.renderCalendar(lines, width, budget);
    if (controls) {
      const action = "[查看详情]";
      const x = width >= 12 ? 1 : 0;
      const y = rows >= 3 ? rows - layout.pinnedLines : lines.length;
      this.hits.push({
        x,
        y,
        width: visibleWidth(truncateToWidth(action, width - x, "")),
        activate: () => this.finish("details"),
      });
      lines.push(
        " ".repeat(x) +
          this.theme.style(action, { fg: "accent", bold: true }) +
          this.theme.fg("muted", "  HTML · Enter"),
      );
    }
    return frame.finish(lines, " ←→ 周  ↑↓ 日  [ ] 年  Esc 关闭");
  }

  private renderCalendar(lines: string[], width: number, budget: number): void {
    const { weeks } = this.calendar;
    const padding = width >= 12 ? 1 : 0;
    const labelWidth = width >= 5 ? 3 : 0;
    const gridX = padding + labelWidth;
    const available = Math.max(1, width - gridX - padding);
    const cellPitch = 2;
    const count = Math.min(
      weeks.length,
      Math.floor((available + 1) / cellPitch),
    );
    this.weekStart = Math.max(
      0,
      Math.min(
        weeks.length - count,
        this.selected.week < this.weekStart
          ? this.selected.week
          : this.selected.week >= this.weekStart + count
            ? this.selected.week - count + 1
            : this.weekStart,
      ),
    );
    const columnX = (column: number) => gridX + column * cellPitch;
    const yearLine = `‹ ${this.calendar.year} ›`;
    const y = lines.length;
    for (const [x, delta] of [
      [padding, -1],
      [padding + visibleWidth(`‹ ${this.calendar.year} `), 1],
    ]) {
      if (x + 1 <= width) {
        this.hits.push({
          x,
          y,
          width: 1,
          activate: () => this.changeYear(delta),
        });
      }
    }
    const detail = `${this.selected.key}: ${tokenLabel(this.selected.tokens)} · $${this.selected.cost.toFixed(2)}`;
    const separateDetail = budget >= 10;
    const window =
      count < weeks.length
        ? ` · W${this.weekStart + 1}–${this.weekStart + count}/${weeks.length}`
        : "";
    lines.push(
      " ".repeat(padding) +
        this.theme.style(yearLine, { fg: "accent", bold: true }) +
        this.theme.fg("muted", window) +
        (separateDetail ? "" : `  ${detail}`),
    );
    const showMonths = budget >= 3;
    if (showMonths) {
      let months = " ".repeat(gridX);
      let end = gridX;
      for (const day of this.calendar.days) {
        if (
          day.date !== 1 ||
          day.week < this.weekStart ||
          day.week >= this.weekStart + count
        )
          continue;
        const x = columnX(day.week - this.weekStart);
        const label = `${day.month + 1}月`;
        if (x < end || x + visibleWidth(label) > width - padding) continue;
        months += " ".repeat(x - end) + label;
        end = x + visibleWidth(label);
      }
      lines.push(this.theme.fg("muted", months));
    }
    const gridRows = Math.max(
      0,
      Math.min(7, budget - 1 - Number(showMonths) - Number(separateDetail)),
    );
    const rowStart = Math.max(
      0,
      Math.min(7 - gridRows, this.selected.weekday - gridRows + 1),
    );
    // Resolve the palette each render so theme invalidation never leaves stale colors.
    const colors = this.theme.colors;
    const palette = [0.08, 0.28, 0.48, 0.7, 0.95].map((amount) =>
      mixColors(colors.toolSuccessBg, colors.success, amount),
    );
    const weekdays = ["日", "一", "二", "三", "四", "五", "六"];
    for (let row = rowStart; row < rowStart + gridRows; row++) {
      let line =
        " ".repeat(padding) +
        (labelWidth ? this.theme.fg("muted", `${weekdays[row]} `) : "");
      let end = gridX;
      const gridY = lines.length;
      for (let column = 0; column < count; column++) {
        const x = columnX(column);
        line += " ".repeat(x - end);
        const day = weeks[this.weekStart + column][row];
        if (day) {
          line += this.theme.style(day === this.selected ? "◆" : "■", {
            fg: day === this.selected ? colors.accent : palette[day.level],
            bold: day === this.selected,
          });
          this.hits.push({
            x,
            y: gridY,
            width: 1,
            activate: () => {
              this.selected = day;
              this.changed();
            },
          });
        } else {
          line += " ";
        }
        end = x + 1;
      }
      lines.push(line);
    }
    if (separateDetail) {
      lines.push(" ".repeat(padding) + this.theme.fg("muted", detail));
    }
  }
}

/** HTML is opened by the caller only after Pi has restored the editor. */
export function showStatsPanel(
  ui: Pick<ExtensionUIContext, "custom">,
  report: StatsReport,
): Promise<StatsPanelAction> {
  return runDockedPanel(
    ui,
    (tui, theme, keys, done) => new StatsPanel(tui, theme, keys, report, done),
    { isCancelled: (action) => action === undefined },
  );
}
