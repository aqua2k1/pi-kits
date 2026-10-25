import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

import {
  Alignment,
  BlockKind,
  OperationKind,
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
export const NewPageParams = Type.Object({
  title: Type.String({ minLength: 1, pattern: "\\S" }),
});
export const InsertParams = Type.Object({
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
export const UpdateParams = Type.Object({
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

// Same-path stores share notifications as well as the file mutation queue.
const subscribers = new Map<string, Set<(commit: DocumentCommit) => void>>();

export function validateBlock(block: Pick<Block, "type" | "spec">) {
  validateBlockContent(block.type, block.spec);
}

function decodeDocument(source: string): Document {
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

function encodeDocument(doc: Document): string {
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
  params: Static<typeof InsertParams>,
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

function planUpdates(doc: Document, params: Static<typeof UpdateParams>) {
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

export class DocumentStore {
  private currentPage?: string;
  constructor(readonly path: string) {}
  subscribe(listener: (commit: DocumentCommit) => void): () => void {
    const key = resolve(this.path);
    let listeners = subscribers.get(key);
    if (!listeners) {
      listeners = new Set();
      subscribers.set(key, listeners);
    }
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (!listeners.size && subscribers.get(key) === listeners)
        subscribers.delete(key);
    };
  }
  async read(): Promise<Document> {
    try {
      return decodeDocument(await readFile(this.path, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { version: 0, pages: [] };
      throw error;
    }
  }
  private mutate<T>(
    change: (doc: Document, operations: Operation[]) => T,
  ): Promise<T> {
    return withFileMutationQueue(this.path, async () => {
      const doc = await this.read();
      const before = documentFingerprint(doc);
      const baseVersion = doc.version;
      const operations: Operation[] = [];
      const result = change(doc, operations);
      doc.version++;
      await mkdir(dirname(this.path), { recursive: true });
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, encodeDocument(doc), {
          mode: 0o600,
        });
        await rename(temporary, this.path);
      } finally {
        await rm(temporary, { force: true });
      }
      const commit = { before, baseVersion, doc, operations };
      // Publish synchronously inside the file queue, only after atomic replacement.
      // Observers cannot turn an already persisted mutation into a failed tool call.
      for (const listener of subscribers.get(resolve(this.path)) ?? []) {
        try {
          listener(structuredClone(commit));
        } catch {
          // Listener failures are isolated from persistence and other subscribers.
        }
      }
      return result;
    });
  }
  async newPage(params: Static<typeof NewPageParams>) {
    if (!Value.Check(NewPageParams, params))
      throw new Error("Invalid page title");
    const pageId = await this.mutate((doc, operations) => {
      const page = pageValue(randomUUID(), params.title);
      operations.push({
        type: OperationKind.CreatePage,
        page,
        index: doc.pages.length,
      });
      doc.pages.push(page);
      return page.id;
    });
    this.currentPage = pageId;
    return { pageId };
  }
  async insert(params: Static<typeof InsertParams>) {
    if (!Value.Check(InsertParams, params))
      throw new Error("Invalid insert_blocks parameters");
    params.blocks.forEach(validateBlock);
    const result = await this.mutate((doc, operations) => {
      const plan = planInsertion(doc, params, this.currentPage);
      const page = plan.page ?? pageValue(randomUUID(), "输出");
      if (!plan.page) {
        operations.push({
          type: OperationKind.CreatePage,
          page: { ...page, blocks: [] },
          index: doc.pages.length,
        });
        doc.pages.push(page);
      }
      const blocks = blockValues(
        params.blocks,
        params.blocks.map(() => randomUUID()),
      );
      page.blocks.splice(plan.index, 0, ...blocks);
      operations.push({
        type: OperationKind.InsertBlocks,
        pageId: page.id,
        index: plan.index,
        blocks,
      });
      return insertionResult(page.id, blocks);
    });
    if (!params.pageId) this.currentPage = result.pageId;
    return result;
  }
  async update(params: Static<typeof UpdateParams>) {
    if (!Value.Check(UpdateParams, params))
      throw new Error("Invalid update_blocks parameters");
    return this.mutate((doc, operations) => {
      const { changes, updated, removed } = planUpdates(doc, params);
      for (const { page, old, next } of changes) {
        const index = page.blocks.indexOf(old);
        if (next === null) page.blocks.splice(index, 1);
        else page.blocks[index] = next;
      }
      operations.push({
        type: OperationKind.UpdateBlocks,
        blocks: changes.flatMap(({ next }) => (next ? [next] : [])),
        removed,
      });
      return { updated, removed };
    });
  }
}
