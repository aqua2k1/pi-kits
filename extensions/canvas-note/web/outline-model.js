/**
 * Pure outline data. Targets are descriptors, never DOM nodes.
 * @typedef {{ ordinal: number, depth: number, label: string }} OutlineHeading
 * @typedef {{ kind: string, pageId: string, blockId?: string, ordinal?: number, id?: string }} OutlineTarget
 * @typedef {{ id: string, kind: string, label: string, depth?: number, target: OutlineTarget, children: OutlineNode[] }} OutlineNode
 */
export const headingTargetId = (blockId, ordinal) =>
  `canvas-heading-${encodeURIComponent(blockId)}-${ordinal}`;

export function headingText(tokens = []) {
  return tokens
    .map((token) => {
      if (token.tokens) return headingText(token.tokens);
      if (token.type === "html") return "";
      if (token.type === "br") return " ";
      return token.text ?? "";
    })
    .join("")
    .replace(
      /&#(x[\da-f]+|\d+);|&(amp|lt|gt|quot|apos|nbsp);/gi,
      (match, code, name) => {
        if (code) {
          const value =
            code[0].toLowerCase() === "x"
              ? Number.parseInt(code.slice(1), 16)
              : Number(code);
          return value > 0 && value <= 0x10ffff
            ? String.fromCodePoint(value)
            : "�";
        }
        return (
          { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " }[
            name.toLowerCase()
          ] ?? match
        );
      },
    )
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * @param {{ id: string, title: string, blocks: { id: string, type: string, title?: string }[] }} page
 * @param {string} mode
 * @param {(blockId: string) => OutlineHeading[]} headingsFor
 * @returns {OutlineNode}
 */
export function buildPageOutline(
  page,
  mode = "structure",
  headingsFor = () => [],
) {
  /** @type {OutlineNode} */
  const root = {
    id: `page:${page.id}`,
    kind: "page",
    label: page.title || "Untitled page",
    target: { kind: "page", pageId: page.id },
    children: [],
  };
  const stack = [root];
  for (const block of page.blocks) {
    if (mode === "structure") {
      root.children.push({
        id: `block:${block.id}`,
        kind: "block",
        label:
          typeof block.title === "string" && block.title.trim()
            ? block.title
            : block.type,
        target: { kind: "block", pageId: page.id, blockId: block.id },
        children: [],
      });
      continue;
    }
    if (block.type !== "text") continue;
    for (const heading of headingsFor(block.id)) {
      /** @type {OutlineNode} */
      const node = {
        id: `heading:${block.id}:${heading.ordinal}`,
        kind: "heading",
        label: heading.label,
        depth: heading.depth,
        target: {
          kind: "heading",
          pageId: page.id,
          blockId: block.id,
          ordinal: heading.ordinal,
          id: headingTargetId(block.id, heading.ordinal),
        },
        children: [],
      };
      while (stack.length > 1 && stack.at(-1).depth >= node.depth) stack.pop();
      stack.at(-1).children.push(node);
      stack.push(node);
    }
  }
  return root;
}
