import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { oneLine } from "./renderers.ts";

export const TREE_BRANCH_MARKER = "├─";
export const TREE_LAST_BRANCH_MARKER = "└─";
export const TREE_CONTINUATION_MARKER = "│";
export const TREE_DETAIL_MARKER = "⎿";
export const TREE_INDENT_WIDTH = 4;

const emptyPrefix = " ".repeat(TREE_INDENT_WIDTH);
const continuationPrefix =
  TREE_CONTINUATION_MARKER + " ".repeat(TREE_INDENT_WIDTH - 1);

export interface TreeNode<T = unknown> {
  /** Single-line content, optionally already styled by the caller. */
  content: string;
  children?: readonly TreeNode<T>[];
  /** Caller-owned identity or action data; never interpreted by the renderer. */
  data?: T;
  /** Optional branch marker, such as ⎿ for a detail row. */
  marker?: string;
}

export interface TreeRow<T = unknown> {
  text: string;
  depth: number;
  data: T | undefined;
}

/** Flat or nested lists with muted connectors; independent of frames and input. */
export function renderTree<T>(
  nodes: readonly TreeNode<T>[],
  theme: Theme,
  width: number,
): TreeRow<T>[] {
  if (width < 1) return [];
  const rows: TreeRow<T>[] = [];
  const visit = (
    items: readonly TreeNode<T>[],
    prefix: string,
    depth: number,
  ) => {
    for (const [index, node] of items.entries()) {
      const last = index === items.length - 1;
      const marker =
        node.marker === undefined
          ? last
            ? TREE_LAST_BRANCH_MARKER
            : TREE_BRANCH_MARKER
          : oneLine(node.marker);
      rows.push({
        text: truncateToWidth(
          `${theme.fg("muted", `${prefix}${marker}`)} ${node.content}`,
          width,
        ),
        depth,
        data: node.data,
      });
      if (node.children?.length) {
        visit(
          node.children,
          prefix + (last ? emptyPrefix : continuationPrefix),
          depth + 1,
        );
      }
    }
  };
  visit(nodes, "", 0);
  return rows;
}
