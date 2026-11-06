import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import type { Static } from "typebox";
import {
  type Document,
  type DocumentChange,
  type DocumentCommit,
  decodeDocument,
  documentFingerprint,
  encodeDocument,
  type InsertBlocksParams,
  type InsertPageParams,
  insertBlocks,
  insertPage,
  type UpdateBlocksParams,
  type UpdatePageParams,
  updateBlocks,
  updatePage,
} from "./model.ts";

// Same-path stores share notifications as well as the file mutation queue.
const subscribers = new Map<string, Set<(commit: DocumentCommit) => void>>();

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
  private mutate<T>(change: (doc: Document) => DocumentChange<T>): Promise<T> {
    return withFileMutationQueue(this.path, async () => {
      const previous = await this.read();
      const before = documentFingerprint(previous);
      const baseVersion = previous.version;
      const { doc, operations, result } = change(previous);
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
  async insertPage(params: Static<typeof InsertPageParams>) {
    params = structuredClone(params);
    const result = await this.mutate((doc) =>
      insertPage(doc, params, randomUUID()),
    );
    this.currentPage = result.pageId;
    return result;
  }
  async insertBlocks(params: Static<typeof InsertBlocksParams>) {
    params = structuredClone(params);
    const result = await this.mutate((doc) =>
      insertBlocks(
        doc,
        params,
        this.currentPage,
        randomUUID(),
        Array.isArray(params?.blocks)
          ? params.blocks.map(() => randomUUID())
          : [],
      ),
    );
    if (!params.pageId) this.currentPage = result.pageId;
    return result;
  }
  async updatePage(params: Static<typeof UpdatePageParams>) {
    params = structuredClone(params);
    const result = await this.mutate((doc) => updatePage(doc, params));
    if (result.deleted && this.currentPage === result.pageId)
      this.currentPage = undefined;
    return result;
  }
  async updateBlocks(params: Static<typeof UpdateBlocksParams>) {
    params = structuredClone(params);
    return this.mutate((doc) => updateBlocks(doc, params));
  }
}
