import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

interface LayoutPart {
  readonly id: string;
  readonly priority: number;
  readonly text: string;
}

/** Sort and pair complete outputs; wrap a pair before clipping either child. */
export function layoutWidgetParts(
  parts: readonly LayoutPart[],
  width: number,
): string[] {
  if (width < 1) return [];
  const content = parts
    .filter((part) => visibleWidth(part.text) > 0)
    .sort(
      (a, b) =>
        a.priority - b.priority || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
  const lines: string[] = [];
  for (let index = 0; index < content.length; index += 2) {
    const left = content[index].text;
    const right = content[index + 1]?.text;
    const gap =
      right === undefined
        ? 0
        : width - visibleWidth(left) - visibleWidth(right);
    if (right !== undefined && gap >= 2) {
      lines.push(left + " ".repeat(gap) + right);
    } else {
      lines.push(truncateToWidth(left, width));
      if (right !== undefined) lines.push(truncateToWidth(right, width));
    }
  }
  return lines;
}
