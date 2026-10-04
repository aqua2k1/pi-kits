import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { fillPanel, panelRule } from "../panel.ts";
import type { TabLayout } from "../tabs.ts";
import type { DockedPanelLayout } from "./layout.ts";

/** Stateless per-render frame: no cached palette, focus, or business state. */
export class DockedPanelFrame {
  constructor(
    private readonly layout: DockedPanelLayout,
    private readonly width: number,
    private readonly theme: Theme,
    private readonly title: string,
  ) {}

  heading(tabs: TabLayout[], active: number): string[] {
    const lines = [
      panelRule(this.width, this.title, (text) =>
        this.theme.fg("accent", this.theme.bold(text)),
      ),
    ];
    if (this.layout.showTabs) {
      let line = "";
      let column = 0;
      for (const tab of tabs) {
        line += " ".repeat(tab.x - column);
        line +=
          tab.index === active
            ? this.theme.fg("accent", this.theme.bold(tab.label))
            : this.theme.fg("muted", tab.label);
        column = tab.x + tab.width;
      }
      lines.push(line);
    }
    return lines;
  }

  /** Compact priorities: active value/cursor, or title+detail above two controls. */
  compactBody(content: {
    progress: string;
    title: string[];
    detail: string[];
    active: () => string[];
    kind: "value" | "input" | "controls";
  }): string[] {
    const { rows } = this.layout;
    const controls = content.kind === "controls";
    const lines: string[] = [];
    if (rows >= 4) {
      if (controls && rows >= 8) lines.push(content.progress);
      if (!controls || rows >= 5) lines.push(content.title[0]);
      if (controls && rows >= 6) lines.push(...content.detail);
    }
    if (rows >= 5 && !controls) lines.push(content.progress);
    if (rows >= 2) {
      if (content.kind === "input" && rows >= 6) lines.push(...content.detail);
      lines.push(...content.active());
      if (content.kind === "value" && rows >= 6) lines.push(...content.detail);
    }
    return lines;
  }

  finish(content: string[], shortcut: string = ""): string[] {
    const { rows, showHints, pinnedLines } = this.layout;
    const lines = [...content];
    if (showHints)
      lines.push(
        this.theme.fg("muted", truncateToWidth(shortcut, this.width, "")),
      );
    if (rows >= 3) lines.push(this.theme.fg("accent", "─".repeat(this.width)));
    const result = fillPanel(lines, this.width, rows, pinnedLines);
    // Tiny docks preserve the title/value and underline instead of adding a rule.
    if (rows < 3) result[rows - 1] = this.theme.underline(result[rows - 1]);
    return result;
  }

  /** Local hit rectangles use the same pinning as finish(), not text searches. */
  controlBounds(lines: string[], contentRows: number) {
    const { rows, pinnedLines, showHints } = this.layout;
    if (rows < 4) return [];
    const total = contentRows + 1 + (showHints ? 1 : 0);
    const tail = Math.min(pinnedLines, rows - 1, total);
    return lines.map((line, index) => ({
      index,
      y: rows - tail + index,
      width: Math.min(this.width, visibleWidth(line)),
    }));
  }
}
