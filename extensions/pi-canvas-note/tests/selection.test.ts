import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createSelectionManager,
  type SelectionSnapshot,
} from "../web/selection-manager.js";

test("selection scopes and manager instances are independent; snapshots are copies", () => {
  const manager = createSelectionManager();
  const other = createSelectionManager();
  assert.equal(manager.size, 0);
  assert.deepEqual(manager.snapshot(), { blockIds: [], pageIds: [] });

  manager.setBlock("same", true);
  manager.setPage("same", true);
  assert.equal(manager.size, 2);
  assert.equal(manager.hasBlock("same"), true);
  assert.equal(manager.hasPage("same"), true);
  assert.equal(other.size, 0);

  const snapshot = manager.snapshot();
  snapshot.blockIds.push("external");
  snapshot.pageIds.length = 0;
  assert.deepEqual(manager.snapshot(), {
    blockIds: ["same"],
    pageIds: ["same"],
  });
  manager.removePage("same");
  assert.equal(manager.hasBlock("same"), true);
  assert.equal(manager.hasPage("same"), false);
  manager.setPage("same", true);
  manager.removeBlock("same");
  assert.equal(manager.hasBlock("same"), false);
  assert.equal(manager.hasPage("same"), true);
  manager.setPage("same", false);
  assert.equal(manager.size, 0);
});

test("subscriptions receive only changed IDs and read after-state; noops stay silent", () => {
  const manager = createSelectionManager();
  const events: { changed: SelectionSnapshot; state: SelectionSnapshot }[] = [];
  const unsubscribe = manager.subscribe((changed) => {
    events.push({ changed, state: manager.snapshot() });
    for (const id of changed.blockIds)
      assert.equal(
        manager.hasBlock(id),
        manager.snapshot().blockIds.includes(id),
      );
    for (const id of changed.pageIds)
      assert.equal(
        manager.hasPage(id),
        manager.snapshot().pageIds.includes(id),
      );
  });
  manager.setBlock("b", false);
  manager.setPage("p", false);
  manager.removeBlock("missing");
  manager.removePage("missing");
  manager.clear();
  manager.remove(
    Object.freeze({ blockIds: Object.freeze([]), pageIds: Object.freeze([]) }),
  );
  assert.equal(events.length, 0);

  manager.setBlock("b", true);
  manager.setBlock("b", true);
  manager.setPage("p", true);
  manager.setPage("p", true);
  manager.setBlock("b", false);
  manager.removeBlock("b");
  manager.setPage("p", false);
  manager.removePage("p");
  assert.deepEqual(events, [
    {
      changed: { blockIds: ["b"], pageIds: [] },
      state: { blockIds: ["b"], pageIds: [] },
    },
    {
      changed: { blockIds: [], pageIds: ["p"] },
      state: { blockIds: ["b"], pageIds: ["p"] },
    },
    {
      changed: { blockIds: ["b"], pageIds: [] },
      state: { blockIds: [], pageIds: ["p"] },
    },
    {
      changed: { blockIds: [], pageIds: ["p"] },
      state: { blockIds: [], pageIds: [] },
    },
  ]);
  unsubscribe();
  unsubscribe();
  manager.setBlock("later", true);
  assert.equal(events.length, 4);
});

test("remove(snapshot) batches exact scopes, ignores stale/duplicate IDs and preserves later selections", () => {
  const manager = createSelectionManager();
  manager.setPage("p", true);
  manager.setBlock("b", true);
  const submitted = manager.snapshot();
  Object.freeze(submitted.blockIds);
  Object.freeze(submitted.pageIds);
  Object.freeze(submitted);
  manager.setBlock("new", true);
  manager.setBlock("p", true);
  manager.setPage("b", true);

  const events: SelectionSnapshot[] = [];
  manager.subscribe((changed) => {
    events.push(changed);
    assert.equal(manager.hasBlock("b"), false);
    assert.equal(manager.hasPage("p"), false);
  });
  manager.remove(submitted);
  assert.deepEqual(events, [{ blockIds: ["b"], pageIds: ["p"] }]);
  assert.deepEqual(manager.snapshot(), {
    blockIds: ["new", "p"],
    pageIds: ["b"],
  });
  manager.remove(submitted);
  assert.equal(events.length, 1);
  manager.remove(
    Object.freeze({
      blockIds: Object.freeze(["new", "new", "missing"]),
      pageIds: Object.freeze(["missing"]),
    }),
  );
  assert.deepEqual(events[1], { blockIds: ["new"], pageIds: [] });
  manager.clear();
  assert.deepEqual(events[2], { blockIds: ["p"], pageIds: ["b"] });
  assert.equal(manager.size, 0);
  manager.clear();
  assert.equal(events.length, 3);
});

test("listeners unsubscribe independently and cannot modify another listener's payload", () => {
  const manager = createSelectionManager();
  const stop = manager.subscribe((changed) => {
    changed.blockIds.length = 0;
    changed.pageIds.push("injected");
  });
  const events: SelectionSnapshot[] = [];
  manager.subscribe((changed) => events.push(changed));
  manager.setBlock("b", true);
  stop();
  manager.setPage("p", true);
  assert.deepEqual(events, [
    { blockIds: ["b"], pageIds: [] },
    { blockIds: [], pageIds: ["p"] },
  ]);
});
