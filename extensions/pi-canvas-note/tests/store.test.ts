import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { DocumentStore } from "../core/store.ts";

test("queued writes snapshot parameters and current-page decisions at invocation", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "canvas-note-store-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new DocumentStore(join(dir, "doc.json"));
  const first = await store.insertPage({ title: "First" });
  const second = await store.insertPage({ title: "Second" });
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const held = withFileMutationQueue(store.path, async () => {
    entered();
    await gate;
  });
  await ready;
  const pageParams = { title: "Queued" };
  const page = store.insertPage(pageParams);
  pageParams.title = "Wrong";
  const blockParams: {
    pageId?: string;
    blocks: { type: "text"; spec: { md: string } }[];
  } = { blocks: [{ type: "text", spec: { md: "Original" } }] };
  const blocks = store.insertBlocks(blockParams);
  blockParams.pageId = first.pageId;
  blockParams.blocks[0].spec.md = "Wrong";
  const renameParams = {
    pageId: second.pageId,
    change: { kind: "rename" as const, title: "Renamed" },
  };
  const renamed = store.updatePage(renameParams);
  renameParams.pageId = first.pageId;
  renameParams.change.title = "Wrong";
  release();
  await held;
  const insertedPage = await page;
  const insertedBlocks = await blocks;
  await renamed;
  assert.equal(insertedBlocks.pageId, insertedPage.pageId);
  const doc = await store.read();
  assert.equal(doc.pages[0].title, "First");
  assert.equal(doc.pages[1].title, "Renamed");
  assert.equal(doc.pages[2].title, "Queued");
  assert.equal(doc.pages[2].blocks[0].spec.md, "Original");
  assert.equal(
    (
      await store.insertBlocks({
        blocks: [{ type: "text", spec: { md: "Current" } }],
      })
    ).pageId,
    insertedPage.pageId,
  );

  const updateParams = {
    blocks: [{ blockId: insertedBlocks.blockIds[0], spec: { md: "Updated" } }],
  };
  const updated = store.updateBlocks(updateParams);
  updateParams.blocks[0].spec.md = "Wrong";
  await updated;
  assert.equal((await store.read()).pages[2].blocks[0].spec.md, "Updated");
});
