import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { oneLine } from "./renderers.ts";
import { layoutWidgetParts } from "./widget-layout.ts";

type WidgetUi = Pick<ExtensionContext["ui"], "setWidget">;
type Tone = "dim" | "warning";

export interface WidgetPart {
  update(text: string, tone?: Tone): void;
  dispose(): void;
}

interface ReadonlyPart {
  readonly priority: number;
  render(theme: Theme): string;
}

interface WidgetRow {
  parts: Map<string, ReadonlyPart>;
  refresh(): void;
}

const WIDGET_ID = "pi-kits-info-row";
// Independent Pi loaders must still attach children to the same parent widget.
const STATE = Symbol.for("@pi-kits/shared/widget-parts/v2");
const registry = globalThis as typeof globalThis & {
  [STATE]?: WeakMap<WidgetUi, WidgetRow>;
};
registry[STATE] ??= new WeakMap<WidgetUi, WidgetRow>();
const rows = registry[STATE];

function createRow(ui: WidgetUi): WidgetRow {
  const parts = new Map<string, ReadonlyPart>();
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
              return layoutWidgetParts(
                [...parts].map(([id, part]) => ({
                  id,
                  priority: part.priority,
                  text: part.render(theme),
                })),
                width,
              );
            },
            invalidate() {},
          };
        },
        { placement: "belowEditor" },
      );
    },
  };
}

/** Each writer owns one child; smaller priorities appear first in the layout. */
export function acquireWidgetPart(
  ui: WidgetUi,
  item: string,
  priority: number,
): WidgetPart {
  if (!Number.isFinite(priority))
    throw new RangeError("Widget priority must be finite");
  const row = rows.get(ui) ?? createRow(ui);
  rows.set(ui, row);
  let text = "";
  let tone: Tone = "dim";
  const part: ReadonlyPart = {
    priority,
    render(theme) {
      const content = oneLine(text);
      return content ? theme.fg(tone, content) : "";
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
