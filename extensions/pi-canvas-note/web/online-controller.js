import { MessageKind } from "../core/contracts.js";
import { exportHtml } from "./export-html.js";
import { exportScope, projectExportDocument } from "./export-scope.js";

export function startOnlineController(view, events) {
  const $ = (id) => document.getElementById(id);
  const {
    pages,
    blocks,
    selectionManager,
    preparePrintScope,
    clearPrintScope,
  } = view;
  const {
    exportMenuPosition,
    controlState,
    selectedReply,
    replySignature,
    replyMessage,
    websocketUrl,
    parseMessage,
    documentPresentation,
    replyFailureText,
    reconnectDelay,
    validOperations,
  } = view.helpers;
  const dialog = $("reply-dialog");
  let awaitingSnapshot = true;
  let documentId;
  let socket;
  let connected = false;
  let closing = false;
  let retry = 0;
  let reconnectTimer;
  let replyContext = null;
  let pending = null;
  let lastSubmission = null;
  let preparingPrint = false;
  let exportingHtml = false;
  function send(message) {
    if (socket?.readyState !== WebSocket.OPEN) return false;
    try {
      socket.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  }

  function positionExportMenu() {
    const menu = $("export-menu");
    if (!menu.matches?.(":popover-open")) return;
    const position = exportMenuPosition(
      $("export-toggle").getBoundingClientRect(),
      menu.getBoundingClientRect(),
      { width: window.innerWidth, height: window.innerHeight },
    );
    menu.style.left = `${position.left}px`;
    menu.style.top = `${position.top}px`;
  }
  $("export-menu").addEventListener("toggle", positionExportMenu);
  window.addEventListener("resize", positionExportMenu);
  window.addEventListener("scroll", positionExportMenu, true);

  function updateControls() {
    const next = controlState({
      count: selectionManager.size,
      connected,
      closing,
      pending,
      replyContext,
      version: view.doc?.version,
    });
    $("selection-count").textContent = next.selectionLabel;
    $("export-toggle").title = selectionManager.size
      ? "Export selected pages and blocks"
      : "Export all pages";
    $("reply").disabled = next.replyDisabled;
    $("clear").disabled = next.clearDisabled;
    $("shutdown").disabled = next.shutdownDisabled;
    $("save-html").disabled =
      exportingHtml || preparingPrint || !view.doc?.pages.length;
    $("save-html").textContent = exportingHtml ? "Exporting…" : "Save HTML";
    $("save-pdf").disabled =
      exportingHtml || preparingPrint || !view.doc?.pages.length;
    $("save-pdf").textContent = preparingPrint ? "Preparing…" : "Save PDF";
    $("submit").disabled = next.submitDisabled;
    $("reply-text").readOnly = next.readOnly;
    $("dismiss").disabled = next.readOnly;
    $("cancel").disabled = next.readOnly;
    $("submit").textContent = next.submitLabel;
    positionExportMenu();
    if (dialog.open && next.staleWarning) {
      $("reply-status").textContent =
        "The document has changed. Your reply is preserved. Close and reopen this dialog to reply to the latest selection.";
    }
  }

  function connectionState(state, label) {
    $("connection").dataset.state = state;
    $("connection").textContent = label;
    updateControls();
  }

  events.selectionChanged = updateControls;
  events.updated = () => {
    connected = true;
    retry = 0;
    connectionState("connected", "Connected");
  };
  events.renderError = (record) =>
    send({
      type: MessageKind.RenderError,
      version: record.errorVersion,
      blockId: record.id,
      message: record.renderError,
    });
  function requestSnapshot() {
    if (awaitingSnapshot) return;
    awaitingSnapshot = true;
    connected = false;
    connectionState("connecting", "Resyncing…");
    if (!send({ type: MessageKind.Resync })) socket?.close();
  }

  // Consume committed operations directly; never scan/diff unrelated pages or blocks.
  function consumeOperations(message) {
    if (awaitingSnapshot) return;
    if (
      !view.doc ||
      message.documentId !== documentId ||
      message.baseVersion !== view.doc.version ||
      message.version !== message.baseVersion + 1 ||
      !validOperations(message.operations, pages, blocks)
    ) {
      requestSnapshot();
      return;
    }
    view.applyOperations(message.operations, message.version);
  }

  $("save-html").addEventListener("click", async () => {
    if (exportingHtml || preparingPrint || !view.doc?.pages.length) return;
    exportingHtml = true;
    $("export-status").textContent = "";
    updateControls();
    try {
      const selected = selectionManager.snapshot();
      const projected = projectExportDocument(view.doc, selected);
      await exportHtml({
        title: document.title,
        doc: projected,
        documentId,
        view: view.snapshotView(),
      });
      $("export-status").textContent = "HTML downloaded";
    } catch (error) {
      $("export-status").textContent = `Export failed: ${String(error)}`;
    } finally {
      exportingHtml = false;
      updateControls();
    }
  });
  $("save-pdf").addEventListener("click", async () => {
    if (exportingHtml || preparingPrint || !view.doc?.pages.length) return;
    preparingPrint = true;
    const selected = selectionManager.snapshot();
    $("save-pdf").title = "";
    updateControls();
    try {
      const scope = exportScope(view.doc, selected);
      const images = scope.blockIds.flatMap((id) =>
        Array.from(blocks.get(id)?.content.querySelectorAll("img") || []),
      );
      await Promise.all([
        document.fonts?.ready,
        ...images.map((image) => image.decode?.().catch(() => {})),
      ]);
      preparePrintScope(selected);
      window.print();
    } catch (error) {
      $("save-pdf").title = `Print failed: ${String(error)}`;
    } finally {
      clearPrintScope();
      view.restoreScreenTheme();
      preparingPrint = false;
      updateControls();
    }
  });

  $("reply").addEventListener("click", () => {
    const selected = selectedReply(
      view.doc.version,
      selectionManager.snapshot(),
      blocks,
      pages,
    );
    replyContext = selected.context;
    $("selected-summaries").replaceChildren();
    for (const summary of selected.summaries) {
      const item = document.createElement("li");
      item.textContent = summary;
      $("selected-summaries").append(item);
    }
    $("reply-context").textContent = selected.label;
    $("reply-status").textContent = "";
    dialog.showModal();
    updateControls();
    $("reply-text").focus();
  });

  $("clear").addEventListener("click", () => {
    selectionManager.clear();
  });

  function dismiss() {
    if (!pending) dialog.close();
  }
  $("dismiss").addEventListener("click", dismiss);
  $("cancel").addEventListener("click", dismiss);
  dialog.addEventListener("cancel", (event) => {
    if (pending) event.preventDefault();
  });

  $("reply-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const reply = $("reply-text").value;
    if (!reply.trim() || $("submit").disabled) return;
    const signature = replySignature(replyContext, reply);
    if (lastSubmission?.signature !== signature) {
      lastSubmission = {
        signature,
        requestId:
          crypto.randomUUID?.() ||
          `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      };
    }
    const requestId = lastSubmission.requestId;
    pending = requestId;
    $("reply-status").textContent = "Waiting for server confirmation…";
    if (!send(replyMessage(requestId, replyContext, reply))) {
      pending = null;
      $("reply-status").textContent =
        "Not connected. Your reply is preserved; try again after reconnecting.";
    }
    updateControls();
  });

  $("shutdown").addEventListener("click", () => {
    if (!connected || closing) return;
    $("shutdown-status").textContent = "";
    $("shutdown-dialog").showModal();
  });

  $("shutdown-confirm").addEventListener("click", () => {
    if (!send({ type: MessageKind.Shutdown })) {
      $("shutdown-status").textContent = "连接已断开，请稍后重试。";
      return;
    }
    $("shutdown-dialog").close();
    $("shutdown").disabled = true;
    $("connection").textContent = "Requesting shutdown…";
  });

  function serverClosing() {
    $("shutdown-dialog").close();
    closing = true;
    connected = false;
    clearTimeout(reconnectTimer);
    pending = null;
    if (dialog.open) {
      $("reply-status").textContent =
        "The server has closed. Your unsent reply is preserved.";
    }
    connectionState("closed", "Server closed");
  }

  function connect() {
    if (closing) return;
    connected = false;
    awaitingSnapshot = true;
    connectionState("connecting", retry ? "Reconnecting…" : "Connecting…");
    socket = new WebSocket(websocketUrl(location.protocol, location.host));
    socket.addEventListener("open", () => {
      connectionState("connecting", "Syncing…");
    });
    socket.addEventListener("message", (event) => {
      const result = parseMessage(event.data);
      if (!result.parsed) return;
      const message = result.message;
      if (message.type === MessageKind.ServerClosing) {
        serverClosing();
      } else if (message.type === MessageKind.Snapshot && !closing) {
        documentId = message.documentId;
        const presentation = documentPresentation(message.documentId);
        if ($("document-id").textContent !== presentation.identity) {
          $("document-id").textContent = presentation.identity;
          $("document-id").hidden = !presentation.identity;
        }
        if (document.title !== presentation.title) {
          document.title = presentation.title;
        }
        awaitingSnapshot = false;
        view.reconcile(message.doc);
      } else if (message.type === MessageKind.Operations && !closing) {
        consumeOperations(message);
      } else if (pending && message.requestId === pending) {
        if (message.type === MessageKind.Ack) {
          pending = null;
          selectionManager.remove(replyContext);
          $("reply-text").value = "";
          replyContext = null;
          lastSubmission = null;
          dialog.close();
          updateControls();
        } else if (message.type === MessageKind.Error) {
          pending = null;
          $("reply-status").textContent = replyFailureText(message.message);
          updateControls();
        }
      }
    });
    socket.addEventListener("close", () => {
      connected = false;
      if (closing) return;
      if (pending) {
        pending = null;
        $("reply-status").textContent =
          "Connection lost before confirmation. Your reply is preserved. Check whether it arrived before retrying.";
      }
      connectionState("disconnected", "Disconnected · retrying…");
      const delay = reconnectDelay(retry);
      retry++;
      reconnectTimer = setTimeout(connect, delay + Math.random() * 300);
    });
    socket.addEventListener("error", () => socket.close());
  }

  window.addEventListener("beforeunload", (event) => {
    if (closing) return;
    event.preventDefault();
    event.returnValue = "";
  });

  window.addEventListener("pagehide", () => {
    closing = true;
    clearTimeout(reconnectTimer);
    socket?.close();
    for (const record of blocks.values()) {
      record.observer?.disconnect();
      record.chart?.dispose();
    }
  });
  connect();
}
