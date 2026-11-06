/**
 * @typedef {import("../core/model.ts").Document} Document
 * @typedef {import("./selection-manager.js").SelectionInput} SelectionInput
 * @typedef {{ all: boolean, pageIds: string[], blockIds: string[] }} ExportScope
 */

/**
 * Projects scopes in document order without changing the document or selection.
 * An empty selection means all; a nonempty, entirely stale selection means none.
 * @param {Document} doc
 * @param {SelectionInput} selectionSnapshot
 * @returns {Document}
 */
export function projectExportDocument(doc, selectionSnapshot) {
  const blockIds = new Set(selectionSnapshot.blockIds);
  const pageIds = new Set(selectionSnapshot.pageIds);
  const all = blockIds.size === 0 && pageIds.size === 0;
  const pages = doc.pages.flatMap((page) => {
    const wholePage = all || pageIds.has(page.id);
    const blocks = page.blocks.filter(
      (block) => wholePage || blockIds.has(block.id),
    );
    return wholePage || blocks.length ? [{ ...page, blocks }] : [];
  });
  return { ...doc, pages };
}

/**
 * Describes the actual exported pages and blocks, not just explicit selections.
 * @param {Document} doc
 * @param {SelectionInput} snapshot
 * @returns {ExportScope}
 */
export function exportScope(doc, snapshot) {
  const projected = projectExportDocument(doc, snapshot);
  return {
    all: snapshot.blockIds.length === 0 && snapshot.pageIds.length === 0,
    pageIds: projected.pages.map((page) => page.id),
    blockIds: projected.pages.flatMap((page) =>
      page.blocks.map((block) => block.id),
    ),
  };
}
