import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

// Preserve ANSI styles and cursor markers, but never emit physical line breaks.
function singleLine(text: string): string {
  return text.replace(/[\r\n\u2028\u2029]/gu, " ");
}

/** Pi editor-style rule, bounded by terminal columns rather than text length. */
export function panelRule(
  width: number,
  label: string,
  paint: (text: string) => string,
): string {
  if (width < 1) return "";
  const content = truncateToWidth(`── ${singleLine(label)} `, width, "");
  const rule = "─".repeat(Math.max(0, width - visibleWidth(content)));
  // Styled labels may reset ANSI attributes; repaint the trailing boundary.
  return paint(content) + (rule ? paint(rule) : "");
}

/** Opaque half-screen frame: fill every cell and keep input/footer at the bottom. */
export function fillPanel(
  lines: string[],
  width: number,
  rows: number,
  pinned = 2,
): string[] {
  const tail = rows >= 3 ? Math.min(pinned, rows - 1, lines.length) : 0;
  const head = lines.slice(
    0,
    Math.max(0, Math.min(lines.length - tail, rows - tail)),
  );
  const bottom = tail ? lines.slice(-tail) : [];
  const blank = Array.from(
    { length: Math.max(0, rows - head.length - bottom.length) },
    () => "",
  );
  return [...head, ...blank, ...bottom].map((line) => {
    const fitted = truncateToWidth(singleLine(line), width, "");
    return fitted + " ".repeat(Math.max(0, width - visibleWidth(fitted)));
  });
}
