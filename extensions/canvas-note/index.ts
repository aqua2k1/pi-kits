import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { readPiKitsConfig } from "@pi-kits/config";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { createFeedbackInbox } from "./core/feedback.ts";
import {
  InsertBlocksParams,
  InsertBlocksToolParams,
  InsertPageParams,
  UpdateBlocksParams,
  UpdatePageParams,
} from "./core/model.ts";
import {
  formatDocumentId,
  renderFailureMessage,
  savedBlocksFailure,
  savedDocumentId,
  sshAddressWarning,
  statusText,
  toolResult,
} from "./core/presentation.ts";
import { DocumentStore } from "./core/store.ts";
import {
  type CanvasNoteServer,
  resolveCanvasHost,
  startCanvasNoteServer,
} from "./server/index.ts";

export default function canvasNoteExtension(pi: ExtensionAPI) {
  const config = readPiKitsConfig()["canvas-note"];
  if (!config.enabled) return;
  const feedbackInbox = createFeedbackInbox(pi);
  let store: DocumentStore | undefined;
  let server: CanvasNoteServer | undefined;
  let latestContext: ExtensionContext | undefined;
  let repairs = 0;
  let addressWarningShown = false;
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const result = queue.then(fn);
    queue = result.catch(() => undefined);
    return result;
  };
  function checkAddress(ctx: ExtensionContext) {
    const text = sshAddressWarning(
      resolveCanvasHost(undefined) === "0.0.0.0",
      process.env.CANVAS_NOTE_PUBLIC_HOST,
    );
    if (addressWarningShown || !text) return;
    ctx.ui.notify(text, "warning");
    addressWarningShown = true;
  }
  function getStore(ctx: ExtensionContext) {
    latestContext = ctx;
    checkAddress(ctx);
    if (!store) {
      const saved = savedDocumentId(ctx.sessionManager.getBranch());
      const id = saved ?? formatDocumentId(new Date(), randomUUID());
      if (id !== saved) pi.appendEntry("canvas-note-document", { id });
      store = new DocumentStore(
        join(ctx.cwd, "docs", "canvas-notes", id, "doc.json"),
      );
    }
    return store;
  }
  function status() {
    latestContext?.ui.setStatus("canvas-note", statusText(server?.url));
  }
  async function stop() {
    const previous = server;
    server = undefined;
    await previous?.close();
    status();
  }
  async function ensureServer(docStore: DocumentStore) {
    if (!server) {
      server = await startCanvasNoteServer({
        ...config,
        store: docStore,
        onReply: (feedback) => feedbackInbox.accept(feedback, docStore.path),
        onRenderError: (error) => {
          if (repairs >= 3) return;
          repairs++;
          pi.sendMessage(renderFailureMessage(error), {
            triggerTurn: true,
            deliverAs: "followUp",
          });
        },
        onShutdown: (reason) =>
          serial(async () => {
            if (reason === "button" || server?.clientCount === 0) await stop();
          }),
        onError: (error) =>
          latestContext?.ui.notify(`Canvas Note: ${String(error)}`, "error"),
      });
      status();
    }
    await server.flush();
    return server;
  }
  const common = {
    namespace: {
      name: "canvas-note",
      description:
        "Canvas Note: Present charts, plans, designs, math, and code as interactive documents with block-level user feedback.",
      instructions:
        "Organize content into semantic pages and independently editable blocks. Keep related content together, but separate sections that users may want to review or revise individually.\n\nUse insert_page for a distinct topic or section; otherwise insert into an existing page. Pass pageId explicitly when working across pages or resuming an existing document.\n\nUse update_page to rename a page or delete it and all its blocks. Use returned blockIds to revise existing content rather than inserting duplicates. Read documentPath with the read tool when you need current content or IDs.\n\nTreat selected block snapshots as context for the user's feedback. Answer questions directly; use update_blocks when the user requests changes.",
    },
    executionMode: "sequential" as const,
  };
  const location = { documentPath: Type.String(), version: Type.Integer() };
  const strings = Type.Array(Type.String());
  pi.registerTool({
    ...common,
    name: "insert_page",
    label: "Canvas Note · Insert page",
    description: "Insert a named semantic page and make it current.",
    parameters: InsertPageParams,
    outputSchema: Type.Object({ pageId: Type.String(), ...location }),
    async execute(_id, params, signal, _update, ctx) {
      return serial(async () => {
        signal?.throwIfAborted();
        const docStore = getStore(ctx);
        const result = {
          ...(await docStore.insertPage(params)),
          documentPath: docStore.path,
          version: (await docStore.read()).version,
        };
        await server?.flush();
        return toolResult("Page inserted.", result);
      });
    },
  });
  pi.registerTool({
    ...common,
    name: "update_page",
    label: "Canvas Note · Update page",
    description: "Rename a page or delete it and all its blocks.",
    parameters: UpdatePageParams,
    outputSchema: Type.Object({
      pageId: Type.String(),
      deleted: Type.Boolean(),
      ...location,
    }),
    async execute(_id, params, signal, _update, ctx) {
      return serial(async () => {
        signal?.throwIfAborted();
        const docStore = getStore(ctx);
        const result = {
          ...(await docStore.updatePage(params)),
          documentPath: docStore.path,
          version: (await docStore.read()).version,
        };
        await server?.flush();
        return toolResult("Page updated.", result);
      });
    },
  });
  pi.registerTool({
    ...common,
    name: "insert_blocks",
    label: "Canvas Note · Insert blocks",
    description:
      "Insert blocks into a page in a single atomic batch. Returns stable block IDs and a browser URL.",
    parameters: InsertBlocksToolParams,
    outputSchema: Type.Object({
      pageId: Type.String(),
      blockIds: strings,
      url: Type.String(),
      ...location,
    }),
    async execute(_id, params, signal, _update, ctx) {
      return serial(async () => {
        signal?.throwIfAborted();
        if (!Value.Check(InsertBlocksParams, params))
          throw new Error("Invalid insert_blocks parameters");
        const docStore = getStore(ctx);
        const inserted = await docStore.insertBlocks(params);
        let view: CanvasNoteServer;
        try {
          view = await ensureServer(docStore);
        } catch (error) {
          throw new Error(
            savedBlocksFailure(inserted.blockIds, docStore.path, error),
          );
        }
        const result = {
          ...inserted,
          url: view.url,
          documentPath: docStore.path,
          version: (await docStore.read()).version,
        };
        return toolResult("Blocks inserted.", result);
      });
    },
  });
  pi.registerTool({
    ...common,
    name: "update_blocks",
    label: "Canvas Note · Update blocks",
    description:
      "Update or delete blocks by ID in a single atomic batch. Omitted fields remain unchanged; spec is replaced entirely.",
    parameters: UpdateBlocksParams,
    outputSchema: Type.Object({
      updated: strings,
      removed: strings,
      url: Type.String(),
      ...location,
    }),
    async execute(_id, params, signal, _update, ctx) {
      return serial(async () => {
        signal?.throwIfAborted();
        const docStore = getStore(ctx);
        const changed = await docStore.updateBlocks(params);
        const view = await ensureServer(docStore);
        const result = {
          ...changed,
          url: view.url,
          documentPath: docStore.path,
          version: (await docStore.read()).version,
        };
        return toolResult("Blocks updated.", result);
      });
    },
  });
  pi.on("session_start", async (_event, ctx) => {
    latestContext = ctx;
    await feedbackInbox.restore(ctx);
    checkAddress(ctx);
  });
  pi.on("session_shutdown", () =>
    serial(async () => {
      await stop();
      store = undefined;
      latestContext = undefined;
      repairs = 0;
      addressWarningShown = false;
      feedbackInbox.clear();
    }),
  );
}
