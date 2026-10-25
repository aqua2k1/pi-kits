import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

import {
  Alignment,
  BlockKind,
  isPageChange,
  OperationKind,
  PageChangeKind,
  validateBlockContent,
} from "./contracts.js";

export const BlockType = Type.Enum(BlockKind);
export const Align = Type.Enum(Alignment);
export const BlockTitle = Type.String({
  minLength: 1,
  pattern: "\\S",
});
const Spec = Type.Record(Type.String(), Type.Unknown());
const blockMetadata = {
  title: Type.Optional({
    ...BlockTitle,
    description: "Optional outline label.",
  }),
  align: Type.Optional({
    ...Align,
    description: "Block alignment; defaults to left.",
  }),
};
export const InsertBlock = Type.Union([
  Type.Object({
    type: Type.Literal(BlockKind.Text),
    ...blockMetadata,
    spec: Type.Object({
      md: Type.String({ description: "Markdown content." }),
    }),
  }),
  Type.Object({
    type: Type.Literal(BlockKind.Math),
    ...blockMetadata,
    spec: Type.Object({
      latex: Type.String({ description: "LaTeX expression." }),
    }),
  }),
  Type.Object({
    type: Type.Literal(BlockKind.Table),
    ...blockMetadata,
    spec: Type.Object({
      columns: Type.Array(Type.String()),
      rows: Type.Array(Type.Array(Type.Unknown())),
    }),
  }),
  Type.Object({
    type: Type.Literal(BlockKind.Code),
    ...blockMetadata,
    spec: Type.Object({
      code: Type.String({ description: "Source code, preserved verbatim." }),
      language: Type.Optional(
        Type.String({
          description:
            "Highlight.js language or alias; omitted or unsupported uses plain text.",
        }),
      ),
    }),
  }),
  Type.Object({
    type: Type.Literal(BlockKind.Chart),
    ...blockMetadata,
    spec: Type.Record(Type.String(), Type.Unknown(), {
      description: "Native ECharts option object. JSON only.",
    }),
  }),
  Type.Object({
    type: Type.Literal(BlockKind.Divider),
    ...blockMetadata,
    spec: Spec,
  }),
]);
export const InsertPageParams = Type.Object({
  title: Type.String({ minLength: 1, pattern: "\\S" }),
});
export const PageChangeSchema = Type.Union([
  Type.Object(
    {
      kind: Type.Literal(PageChangeKind.Rename),
      title: Type.String({
        minLength: 1,
        pattern: "\\S",
        description: "New page title; must differ from the current title.",
      }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    { kind: Type.Literal(PageChangeKind.Delete) },
    { additionalProperties: false },
  ),
]);
export const UpdatePageParams = Type.Object(
  {
    pageId: Type.String({ description: "Existing page ID." }),
    change: PageChangeSchema,
  },
  { additionalProperties: false },
);
export const InsertBlocksParams = Type.Object({
  pageId: Type.Optional(
    Type.String({
      description:
        "Target page ID. If omitted, uses the current page or creates one if none is current.",
    }),
  ),
  index: Type.Optional(
    Type.Integer({
      minimum: 0,
      description:
        "Zero-based position to insert before. Omit or exceed the block count to append.",
    }),
  ),
  blocks: Type.Array(InsertBlock, { minItems: 1 }),
});
export const UpdateBlocksParams = Type.Object({
  blocks: Type.Array(
    Type.Object({
      blockId: Type.String({
        description:
          "Existing block ID. Each ID may appear only once per batch.",
      }),
      type: Type.Optional(
        Type.Union([BlockType, Type.Null()], {
          description:
            "Null deletes the block. Changing type requires a complete spec.",
        }),
      ),
      title: Type.Optional(
        Type.Union([BlockTitle, Type.Null()], {
          description: "Outline label; null clears it.",
        }),
      ),
      align: Type.Optional({ ...Align, description: "Block alignment." }),
      spec: Type.Optional(
        Type.Record(Type.String(), Type.Unknown(), {
          description: "Complete spec for the block's resulting type.",
        }),
      ),
    }),
    { minItems: 1 },
  ),
});
export const BlockSchema = Type.Object({
  id: Type.String(),
  type: BlockType,
  title: Type.Optional(BlockTitle),
  align: Align,
  spec: Spec,
});
export const DocumentSchema = Type.Object({
  version: Type.Integer({ minimum: 0 }),
  pages: Type.Array(
    Type.Object({
      id: Type.String(),
      title: Type.String(),
      blocks: Type.Array(BlockSchema),
    }),
  ),
});
export type Block = Static<typeof BlockSchema>;
export type Document = Static<typeof DocumentSchema>;
export type Page = Document["pages"][number];

export type Operation =
  | { type: typeof OperationKind.CreatePage; page: Page; index: number }
  | {
      type: typeof OperationKind.UpdatePage;
      pageId: string;
      change: Static<typeof PageChangeSchema>;
    }
  | {
      type: typeof OperationKind.InsertBlocks;
      pageId: string;
      index: number;
      blocks: Block[];
    }
  | {
      type: typeof OperationKind.UpdateBlocks;
      blocks: Block[];
      removed: string[];
    };

export type DocumentCommit = {
  before: string;
  baseVersion: number;
  doc: Document;
  operations: Operation[];
};

export function documentFingerprint(doc: Document): string {
  return JSON.stringify(doc);
}

export function validateBlock(block: Pick<Block, "type" | "spec">) {
  validateBlockContent(block.type, block.spec);
}

export function decodeDocument(source: string): Document {
  const doc: unknown = JSON.parse(source);
  if (!Value.Check(DocumentSchema, doc))
    throw new Error("Invalid Canvas Note document");
  const ids = new Set<string>();
  for (const page of doc.pages) {
    if (ids.has(page.id)) throw new Error("Duplicate page ID");
    ids.add(page.id);
    for (const block of page.blocks) {
      if (ids.has(block.id)) throw new Error("Duplicate block ID");
      ids.add(block.id);
      validateBlock(block);
    }
  }
  return doc;
}

export function encodeDocument(doc: Document): string {
  return `${JSON.stringify(doc, null, 2)}\n`;
}

function pageValue(id: string, title: string): Page {
  return { id, title, blocks: [] };
}

function blockValues(
  inputs: Static<typeof InsertBlock>[],
  ids: string[],
): Block[] {
  return inputs.map((block, index) => ({
    ...block,
    align: block.align ?? Alignment.Left,
    id: ids[index],
  }));
}

function planInsertion(
  doc: Document,
  params: Static<typeof InsertBlocksParams>,
  currentPage: string | undefined,
) {
  const page = doc.pages.find(
    (item) => item.id === (params.pageId ?? currentPage),
  );
  if (!page && params.pageId)
    throw new Error(`Unknown pageId: ${params.pageId}`);
  const length = page?.blocks.length ?? 0;
  return { page, index: Math.min(params.index ?? length, length) };
}

function insertionResult(pageId: string, blocks: Block[]) {
  return { pageId, blockIds: blocks.map((block) => block.id) };
}

function planUpdates(doc: Document, params: Static<typeof UpdateBlocksParams>) {
  const seen = new Set<string>();
  const changes: { page: Page; old: Block; next: Block | null }[] = [];
  const updated: string[] = [],
    removed: string[] = [];
  for (const patch of params.blocks) {
    if (seen.has(patch.blockId))
      throw new Error(`Duplicate update: ${patch.blockId}`);
    seen.add(patch.blockId);
    const page = doc.pages.find((p) =>
      p.blocks.some((b) => b.id === patch.blockId),
    );
    const index = page?.blocks.findIndex((b) => b.id === patch.blockId) ?? -1;
    if (!page || index < 0)
      throw new Error(`Unknown blockId: ${patch.blockId}`);
    const old = page.blocks[index];
    if (patch.type === null) {
      changes.push({ page, old, next: null });
      removed.push(old.id);
      continue;
    }
    if (patch.type && patch.type !== old.type && patch.spec === undefined)
      throw new Error(`Block ${old.id}: changing type requires complete spec`);
    const title =
      patch.title === undefined
        ? old.title
        : patch.title === null
          ? undefined
          : patch.title;
    const next: Block = {
      id: old.id,
      type: patch.type ?? old.type,
      align: patch.align ?? old.align,
      spec: patch.spec ?? old.spec,
      ...(title === undefined ? {} : { title }),
    };
    validateBlock(next);
    changes.push({ page, old, next });
    updated.push(old.id);
  }
  return { changes, updated, removed };
}

export type DocumentChange<T> = {
  doc: Document;
  operations: Operation[];
  result: T;
};

// Changes are pure: no I/O, random IDs, version increments or input mutation.
export function insertPage(
  doc: Document,
  params: Static<typeof InsertPageParams>,
  pageId: string,
): DocumentChange<{ pageId: string }> {
  if (!Value.Check(InsertPageParams, params))
    throw new Error("Invalid page title");
  const next = structuredClone(doc);
  const page = pageValue(pageId, params.title);
  const operation: Operation = {
    type: OperationKind.CreatePage,
    page: { ...page, blocks: [] },
    index: next.pages.length,
  };
  next.pages.push(page);
  return { doc: next, operations: [operation], result: { pageId } };
}

export function updatePage(
  doc: Document,
  params: Static<typeof UpdatePageParams>,
): DocumentChange<{ pageId: string; deleted: boolean }> {
  if (!Value.Check(UpdatePageParams, params) || !isPageChange(params.change))
    throw new Error("Invalid update_page parameters");
  const index = doc.pages.findIndex((page) => page.id === params.pageId);
  if (index < 0) throw new Error(`Unknown pageId: ${params.pageId}`);
  const change = params.change;
  if (
    change.kind === PageChangeKind.Rename &&
    change.title === doc.pages[index].title
  )
    throw new Error("Page title is unchanged");
  const next = structuredClone(doc);
  switch (change.kind) {
    case PageChangeKind.Delete:
      next.pages.splice(index, 1);
      break;
    case PageChangeKind.Rename:
      next.pages[index].title = change.title;
      break;
  }
  return {
    doc: next,
    operations: [
      {
        type: OperationKind.UpdatePage,
        pageId: params.pageId,
        change: { ...change },
      },
    ],
    result: {
      pageId: params.pageId,
      deleted: change.kind === PageChangeKind.Delete,
    },
  };
}

export function insertBlocks(
  doc: Document,
  params: Static<typeof InsertBlocksParams>,
  currentPage: string | undefined,
  pageId: string,
  blockIds: string[],
): DocumentChange<{ pageId: string; blockIds: string[] }> {
  if (!Value.Check(InsertBlocksParams, params))
    throw new Error("Invalid insert_blocks parameters");
  params.blocks.forEach(validateBlock);
  const next = structuredClone(doc);
  const operations: Operation[] = [];
  const plan = planInsertion(next, params, currentPage);
  const page = plan.page ?? pageValue(pageId, "输出");
  if (!plan.page) {
    operations.push({
      type: OperationKind.CreatePage,
      page: { ...page, blocks: [] },
      index: next.pages.length,
    });
    next.pages.push(page);
  }
  const blocks = blockValues(structuredClone(params.blocks), blockIds);
  page.blocks.splice(plan.index, 0, ...blocks);
  operations.push({
    type: OperationKind.InsertBlocks,
    pageId: page.id,
    index: plan.index,
    blocks,
  });
  return { doc: next, operations, result: insertionResult(page.id, blocks) };
}

export function updateBlocks(
  doc: Document,
  params: Static<typeof UpdateBlocksParams>,
): DocumentChange<{ updated: string[]; removed: string[] }> {
  if (!Value.Check(UpdateBlocksParams, params))
    throw new Error("Invalid update_blocks parameters");
  const next = structuredClone(doc);
  const { changes, updated, removed } = planUpdates(
    next,
    structuredClone(params),
  );
  for (const { page, old, next: block } of changes) {
    const index = page.blocks.indexOf(old);
    if (block === null) page.blocks.splice(index, 1);
    else page.blocks[index] = block;
  }
  return {
    doc: next,
    operations: [
      {
        type: OperationKind.UpdateBlocks,
        blocks: changes.flatMap(({ next }) => (next ? [next] : [])),
        removed,
      },
    ],
    result: { updated, removed },
  };
}
