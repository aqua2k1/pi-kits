import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export interface TabLayout {
  index: number;
  x: number;
  width: number;
  label: string;
}

/** A single-row viewport; the active tab is always visible, even at width 1. */
export function layoutTabs(
  labels: readonly string[],
  active: number,
  width: number,
): TabLayout[] {
  if (width < 1 || labels.length === 0) return [];
  const count = labels.length;
  const label = (index: number) => labels[index];
  const room = Math.max(1, width - (width >= 7 ? 4 : 0));
  let start = Math.max(0, Math.min(active, count - 1));
  let end = start + 1;
  let used = Math.min(room, visibleWidth(label(start)));
  while (end < count && used + 1 + visibleWidth(label(end)) <= room) {
    used += 1 + visibleWidth(label(end++));
  }
  while (start > 0 && used + 1 + visibleWidth(label(start - 1)) <= room) {
    used += 1 + visibleWidth(label(--start));
  }
  const tabs: TabLayout[] = [];
  let x = 0;
  const add = (index: number, text: string, available: number) => {
    const clipped = truncateToWidth(text, available, "");
    const size = visibleWidth(clipped);
    tabs.push({ index, x, width: size, label: clipped });
    x += size;
  };
  if (width >= 7) {
    if (start > 0) add(start - 1, "‹", 1);
    else x++;
    x++;
  }
  for (let index = start; index < end; index++) {
    if (index > start) x++;
    add(index, label(index), room);
  }
  if (width >= 7 && end < count) {
    x++;
    add(end, "›", 1);
  }
  return tabs;
}

/** Normalized component-local cells, not raw terminal mouse escape sequences. */
export function tabAt(
  tabs: TabLayout[],
  x: number,
  y: number,
): number | undefined {
  if (y !== 0) return undefined;
  return tabs.find((tab) => x >= tab.x && x < tab.x + tab.width)?.index;
}
