import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { oneLine } from "./renderers.ts";

type WidgetUi = Pick<ExtensionContext["ui"], "setWidget">;
const ROW_LAYOUT = {
  "provider-usage": "left",
  "token-meter": "right",
} as const;
type RowItem = keyof typeof ROW_LAYOUT;
type RowTone = "dim" | "warning";
interface WidgetRow {
  left: string;
  right: string;
  leftTone: RowTone;
  rightTone: RowTone;
}

const ROW_WIDGET_ID = "pi-kits-info-row";
const widgetRows = new WeakMap<WidgetUi, WidgetRow>();

/** Shared below-editor layout. Callers identify content, not its position. */
export function setWidgetRow(
  ui: WidgetUi,
  item: RowItem,
  text: string,
  tone: RowTone = "dim",
): void {
  const side = ROW_LAYOUT[item];
  const row: WidgetRow = {
    left: "",
    right: "",
    leftTone: "dim",
    rightTone: "dim",
    ...widgetRows.get(ui),
    [side]: text,
    [`${side}Tone`]: tone,
  };
  if (!row.left && !row.right) {
    if (widgetRows.delete(ui)) ui.setWidget(ROW_WIDGET_ID, undefined);
    return;
  }
  widgetRows.set(ui, row);
  ui.setWidget(
    ROW_WIDGET_ID,
    (_tui, theme) => ({
      render(width) {
        if (width < 1) return [];
        const style = (value: string, color: RowTone) =>
          value ? theme.fg(color, oneLine(value)) : "";
        const right = truncateToWidth(style(row.right, row.rightTone), width);
        const rightWidth = visibleWidth(right);
        const leftBudget =
          rightWidth > 0 ? Math.max(0, width - rightWidth - 2) : width;
        const left = truncateToWidth(style(row.left, row.leftTone), leftBudget);
        const gap =
          rightWidth > 0 ? width - visibleWidth(left) - rightWidth : 0;
        return [left + " ".repeat(gap) + right];
      },
      invalidate() {},
    }),
    { placement: "belowEditor" },
  );
}

/** Content coordinates relative to the rendered widget, for caller-owned hit testing. */
export function widgetContentBounds(width: number) {
  const bordered = width >= 24;
  return {
    x: bordered ? 2 : 0,
    y: 1,
    width: Math.max(0, bordered ? width - 4 : width),
    bordered,
  };
}

/** Stateless widget frame; the caller owns content, height and lifecycle. */
export function renderWidgetFrame(
  title: string,
  theme: Theme,
  width: number,
  renderBody: (contentWidth: number) => string[],
): string[] {
  if (width < 1) return [];
  const { bordered, width: contentWidth } = widgetContentBounds(width);
  const body = renderBody(contentWidth);
  if (!body.length) return [];
  const heading = oneLine(title);
  if (!bordered) {
    return [theme.fg("accent", theme.bold(heading)), ...body].map((line) =>
      truncateToWidth(line, width),
    );
  }
  const edge = (text: string) => theme.fg("dim", text);
  const label = ` ${truncateToWidth(heading, width - 5)} `;
  return [
    edge("╭─") +
      theme.fg("accent", theme.bold(label)) +
      edge(`${"─".repeat(width - visibleWidth(label) - 3)}╮`),
    ...body.map((line) => {
      const clipped = truncateToWidth(line, contentWidth);
      return (
        edge("│ ") +
        clipped +
        " ".repeat(contentWidth - visibleWidth(clipped)) +
        edge(" │")
      );
    }),
    edge(`╰${"─".repeat(width - 2)}╯`),
  ];
}
