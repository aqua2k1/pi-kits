/**
 * @typedef {{ blockIds: string[], pageIds: string[] }} SelectionSnapshot
 * @typedef {{ readonly blockIds: readonly string[], readonly pageIds: readonly string[] }} SelectionInput
 * @typedef {(changed: SelectionSnapshot) => void} SelectionListener
 */

/** Owns selection only; subscribers synchronize changed DOM IDs from hasBlock/hasPage. */
export function createSelectionManager() {
  /** @type {Set<string>} */
  const blockSelection = new Set();
  /** @type {Set<string>} */
  const pageSelection = new Set();
  /** @type {Set<SelectionListener>} */
  const listeners = new Set();

  /** @param {SelectionSnapshot} changed */
  function notify(changed) {
    if (!changed.blockIds.length && !changed.pageIds.length) return;
    for (const listener of [...listeners]) {
      listener({
        blockIds: [...changed.blockIds],
        pageIds: [...changed.pageIds],
      });
    }
  }

  /**
   * @param {Set<string>} selection
   * @param {string} id
   * @param {boolean} checked
   * @returns {boolean}
   */
  function set(selection, id, checked) {
    if (selection.has(id) === checked) return false;
    if (checked) selection.add(id);
    else selection.delete(id);
    return true;
  }

  /** @returns {SelectionSnapshot} */
  function snapshot() {
    return { blockIds: [...blockSelection], pageIds: [...pageSelection] };
  }

  /** @param {SelectionInput} selected */
  function remove(selected) {
    const blockIds = selected.blockIds.filter((id) =>
      blockSelection.delete(id),
    );
    const pageIds = selected.pageIds.filter((id) => pageSelection.delete(id));
    notify({ blockIds, pageIds });
  }

  return {
    get size() {
      return blockSelection.size + pageSelection.size;
    },
    /** @param {string} id */
    hasBlock(id) {
      return blockSelection.has(id);
    },
    /** @param {string} id */
    hasPage(id) {
      return pageSelection.has(id);
    },
    /**
     * @param {string} id
     * @param {boolean} checked
     */
    setBlock(id, checked) {
      if (set(blockSelection, id, checked))
        notify({ blockIds: [id], pageIds: [] });
    },
    /**
     * @param {string} id
     * @param {boolean} checked
     */
    setPage(id, checked) {
      if (set(pageSelection, id, checked))
        notify({ blockIds: [], pageIds: [id] });
    },
    /** @param {string} id */
    removeBlock(id) {
      remove({ blockIds: [id], pageIds: [] });
    },
    /** @param {string} id */
    removePage(id) {
      remove({ blockIds: [], pageIds: [id] });
    },
    clear() {
      remove(snapshot());
    },
    snapshot,
    remove,
    /**
     * @param {SelectionListener} callback
     * @returns {() => void}
     */
    subscribe(callback) {
      listeners.add(callback);
      return () => {
        listeners.delete(callback);
      };
    },
  };
}
