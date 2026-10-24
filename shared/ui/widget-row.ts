import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { oneLine } from "./renderers.ts";

type WidgetUi = Pick<ExtensionContext["ui"], "setWidget">;
type Tone = "dim" | "warning";
const ROW_LAYOUT = { left: "provider-usage", right: "token-meter" } as const;
type Item = (typeof ROW_LAYOUT)[keyof typeof ROW_LAYOUT];

export interface WidgetPart {
  update(text: string, tone?: Tone): void;
  dispose(): void;
}

interface ReadonlyPart {
  render(width: number, theme: Theme): string;
}

interface WidgetRow {
  parts: Map<Item, ReadonlyPart>;
  refresh(): void;
}

const WIDGET_ID = "pi-kits-info-row";
// Independent Pi loaders must still attach children to the same parent widget.
const STATE = Symbol.for("@pi-kits/shared/widget-parts/v1");
const registry = globalThis as typeof globalThis & {
  [STATE]?: WeakMap<WidgetUi, WidgetRow>;
};
registry[STATE] ??= new WeakMap<WidgetUi, WidgetRow>();
const rows = registry[STATE];

function createRow(ui: WidgetUi): WidgetRow {
  const parts = new Map<Item, ReadonlyPart>();
  let mounted = false;
  let requestRender = () => {};
  return {
    parts,
    refresh() {
      if (mounted) {
        requestRender();
        return;
      }
      mounted = true;
      ui.setWidget(
        WIDGET_ID,
        (tui, theme) => {
          requestRender = () => tui.requestRender();
          return {
            render(width) {
              if (width < 1) return [];
              const right =
                parts.get(ROW_LAYOUT.right)?.render(width, theme) ?? "";
              const rightWidth = visibleWidth(right);
              const leftWidth = rightWidth
                ? Math.max(0, width - rightWidth - 2)
                : width;
              const left =
                parts.get(ROW_LAYOUT.left)?.render(leftWidth, theme) ?? "";
              if (!left && !right) return [];
              const gap = rightWidth
                ? width - visibleWidth(left) - rightWidth
                : 0;
              return [left + " ".repeat(gap) + right];
            },
            invalidate() {},
          };
        },
        { placement: "belowEditor" },
      );
    },
  };
}

/** Each writer owns one child; the shared parent only reads its rendered output. */
export function acquireWidgetPart(ui: WidgetUi, item: Item): WidgetPart {
  const row = rows.get(ui) ?? createRow(ui);
  rows.set(ui, row);
  let text = "";
  let tone: Tone = "dim";
  const part: ReadonlyPart = {
    render(width, theme) {
      return text && width > 0
        ? truncateToWidth(theme.fg(tone, oneLine(text)), width)
        : "";
    },
  };
  row.parts.set(item, part);
  return {
    update(value, color = "dim") {
      if (row.parts.get(item) !== part) return;
      text = value;
      tone = color;
      row.refresh();
    },
    dispose() {
      if (row.parts.get(item) !== part) return;
      row.parts.delete(item);
      if (row.parts.size) {
        row.refresh();
      } else {
        rows.delete(ui);
        ui.setWidget(WIDGET_ID, undefined);
      }
    },
  };
}
