import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { readPiKitsConfig } from "@pi-kits/config";
import { Type } from "typebox";
import { createFeedbackInbox } from "./core/feedback.ts";
import {
  DocumentStore,
  InsertParams,
  NewPageParams,
  UpdateParams,
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
        onReply: feedbackInbox.accept,
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
        "Canvas Note: browser document pages containing Markdown text, ECharts charts and LaTeX math.",
      instructions:
        "new_page creates a semantic page without starting the server. insert_blocks starts it lazily. Blocks are always arrays, including single elements. text spec={md:string}; math spec={latex:string}; chart spec=native ECharts option (JSON only); table spec={columns:string[],rows:unknown[][]}; divider spec={}. align is left (default), center or right. Use returned blockIds with update_blocks. spec replaces the entire old spec. Read the returned documentPath with the read tool to inspect current content and IDs. Explicit pageId is required when composing concurrent multi-page work.",
    },
    executionMode: "sequential" as const,
  };
  const location = { documentPath: Type.String(), version: Type.Integer() };
  const strings = Type.Array(Type.String());
  pi.registerTool({
    ...common,
    name: "new_page",
    label: "Canvas Note · New page",
    description:
      "Create a named semantic page and make it current. Does not start the web server.",
    parameters: NewPageParams,
    outputSchema: Type.Object({ pageId: Type.String(), ...location }),
    async execute(_id, params, signal, _update, ctx) {
      return serial(async () => {
        signal?.throwIfAborted();
        const docStore = getStore(ctx);
        const result = {
          ...(await docStore.newPage(params)),
          documentPath: docStore.path,
          version: (await docStore.read()).version,
        };
        await server?.flush();
        return toolResult("Page created.", result);
      });
    },
  });
  pi.registerTool({
    ...common,
    name: "insert_blocks",
    label: "Canvas Note · Insert blocks",
    description:
      "Insert a nonempty array of blocks at index (default append). pageId defaults to current page, automatically created if absent. text spec={md}; math={latex}; chart=native ECharts option; table={columns,rows}; divider={}. Batch is atomic. Returns stable block IDs and browser URL. Starts the server lazily.",
    parameters: InsertParams,
    outputSchema: Type.Object({
      pageId: Type.String(),
      blockIds: strings,
      url: Type.String(),
      ...location,
    }),
    async execute(_id, params, signal, _update, ctx) {
      return serial(async () => {
        signal?.throwIfAborted();
        const docStore = getStore(ctx);
        const inserted = await docStore.insert(params);
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
      "Atomically update a nonempty array by blockId. Omitted fields stay unchanged; spec is replaced completely, never deep-merged. type is a strong enum; changing type requires complete spec; type:null deletes the block. Starts/restarts the server lazily.",
    parameters: UpdateParams,
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
        const changed = await docStore.update(params);
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
    feedbackInbox.restore(ctx);
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
