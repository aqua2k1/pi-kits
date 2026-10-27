/** Keyed DOM renderer and fold state shared by both logical outline modes. */
export function createOutlineView({
  document,
  root,
  resolveTarget,
  initialFolds = new Map(),
}) {
  const pages = new Map();
  const folds = new Map(initialFolds);
  const place = (parent, child, index) => {
    if (parent.children[index] !== child)
      parent.insertBefore(child, parent.children[index] || null);
  };
  function expanded(entry) {
    const open = folds.get(entry.node.id) !== false;
    if (entry.children.hidden !== !open) entry.children.hidden = !open;
    const icon = open ? "▾" : "▸";
    if (entry.toggle.textContent !== icon) entry.toggle.textContent = icon;
    const value = String(open);
    if (entry.toggle.getAttribute("aria-expanded") !== value)
      entry.toggle.setAttribute("aria-expanded", value);
    const label = `${open ? "Collapse" : "Expand"} ${entry.node.label}`;
    if (entry.toggle.getAttribute("aria-label") !== label)
      entry.toggle.setAttribute("aria-label", label);
  }
  function create(node) {
    const element = document.createElement("li");
    element.className = `outline-${node.kind}`;
    element.dataset.outlineId = node.id;
    if (node.kind === "page") element.dataset.pageId = node.target.pageId;
    if (node.kind === "block") element.dataset.blockId = node.target.blockId;
    const link = document.createElement("button");
    link.type = "button";
    link.className = `outline-link outline-${node.kind === "heading" ? "block" : node.kind}-link`;
    const entry = { element, link, node };
    link.addEventListener("click", () => {
      resolveTarget(entry.node.target)?.scrollIntoView?.({
        behavior: "smooth",
        block: "start",
      });
    });
    if (node.kind !== "block") {
      const row = document.createElement("div");
      row.className = "outline-page-row";
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "outline-page-toggle";
      const children = document.createElement("ul");
      children.className = "outline-children";
      Object.assign(entry, { toggle, children });
      toggle.addEventListener("click", () => {
        folds.set(entry.node.id, folds.get(entry.node.id) === false);
        expanded(entry);
      });
      row.append(toggle, link);
      element.append(row, children);
    } else element.append(link);
    return entry;
  }
  function removePage(id) {
    pages.get(id)?.element.remove();
    pages.delete(id);
  }
  function updatePage(node, index) {
    let page = pages.get(node.target.pageId);
    if (!page) {
      page = { entries: new Map() };
      pages.set(node.target.pageId, page);
    }
    const live = new Set();
    function visit(node, parent, index, pageLabel) {
      live.add(node.id);
      let entry = page.entries.get(node.id);
      if (!entry) {
        entry = create(node);
        page.entries.set(node.id, entry);
      }
      entry.node = node;
      if (entry.link.textContent !== node.label)
        entry.link.textContent = node.label;
      const label = `Go to ${node.kind === "page" ? "" : `${pageLabel}, `}${node.label}`;
      if (entry.link.getAttribute("aria-label") !== label)
        entry.link.setAttribute("aria-label", label);
      if (node.target.id && entry.link.dataset.targetId !== node.target.id)
        entry.link.dataset.targetId = node.target.id;
      if (entry.toggle) {
        // Pages retain their traditional toggle even when empty.
        const hidden = node.kind !== "page" && !node.children.length;
        if (entry.toggle.hidden !== hidden) entry.toggle.hidden = hidden;
        expanded(entry);
      }
      place(parent, entry.element, index);
      node.children.forEach((child, i) => {
        visit(child, entry.children, i, pageLabel);
      });
      return entry;
    }
    page.element = visit(node, root, index, node.label).element;
    for (const [id, entry] of page.entries) {
      if (live.has(id)) continue;
      entry.element.remove();
      page.entries.delete(id);
    }
  }
  return {
    updatePage,
    removePage,
    snapshotFolds() {
      return Array.from(folds.entries());
    },
    setAllExpanded(open) {
      for (const page of pages.values()) {
        for (const entry of page.entries.values()) {
          if (!entry.toggle) continue;
          folds.set(entry.node.id, open);
          expanded(entry);
        }
      }
    },
    retainPages(ids) {
      for (const id of pages.keys()) if (!ids.has(id)) removePage(id);
    },
  };
}
