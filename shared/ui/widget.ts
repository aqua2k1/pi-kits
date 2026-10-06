import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { oneLine } from "./renderers.ts";

/** Stateless widget frame; the caller owns content, height and lifecycle. */
export function renderWidgetFrame(
  title: string,
  theme: Theme,
  width: number,
  renderBody: (contentWidth: number) => string[],
): string[] {
  if (width < 1) return [];
  const bordered = width >= 24;
  const contentWidth = bordered ? width - 4 : width;
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
