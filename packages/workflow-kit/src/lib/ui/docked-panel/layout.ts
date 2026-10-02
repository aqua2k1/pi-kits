/** Fixed editor-dock policy. Navigation yields to active content below seven rows. */
export function dockedPanelLayout(terminalRows: number, controlRows = 1) {
  const rows = Math.max(1, Math.floor(terminalRows / 2));
  const showTabs = rows >= 7;
  const showHints = rows >= 9;
  const pinnedLines = controlRows + 1 + (showHints ? 1 : 0);
  return { rows, showTabs, showHints, pinnedLines, compact: !showHints };
}

export type DockedPanelLayout = ReturnType<typeof dockedPanelLayout>;

/** Budget wrapped headings/details without displacing controls or list context. */
export function dockedContentBudget(
  layout: DockedPanelLayout,
  titleLines: number,
  detailLines: number,
  itemCount: number,
) {
  const { rows, pinnedLines } = layout;
  const detailHeight = Math.min(rows >= 18 ? 2 : 1, detailLines);
  const titleHeight = Math.min(
    rows < 9 ? 1 : Math.min(3, Math.max(1, Math.floor(rows / 4))),
    titleLines,
    Math.max(1, rows - 3 - detailHeight - pinnedLines - Math.min(2, itemCount)),
  );
  return { titleHeight, detailHeight };
}

/** SelectList needs a row for its scroll indicator when not all items fit. */
export function dockedListBudget(
  layout: DockedPanelLayout,
  headingRows: number,
  detailRows: number,
  itemCount: number,
) {
  const budget = Math.max(
    0,
    layout.rows - headingRows - detailRows - layout.pinnedLines,
  );
  return {
    budget,
    visible: Math.max(1, budget - (itemCount > budget ? 1 : 0)),
  };
}

/** Scroll independent wrapped blocks together, clamping each to its own end. */
export function dockedContentWindow(
  title: string[],
  detail: string[],
  titleHeight: number,
  detailHeight: number,
  offset: number,
) {
  const titleMax = Math.max(0, title.length - titleHeight);
  const detailMax = Math.max(0, detail.length - detailHeight);
  const clamped = Math.min(offset, Math.max(titleMax, detailMax));
  const titleStart = Math.min(clamped, titleMax);
  const detailStart = Math.min(clamped, detailMax);
  return {
    offset: clamped,
    scrollable: !!(titleMax || detailMax),
    title: title.slice(titleStart, titleStart + titleHeight),
    detail: detail
      .slice(detailStart, detailStart + detailHeight)
      .map((line) => `  ${line}`),
  };
}
