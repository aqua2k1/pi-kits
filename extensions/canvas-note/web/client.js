{
  const blockSummary = (block, pageTitle) => {
    const text =
      block.type === "text"
        ? block.spec.md
        : block.type === "math"
          ? block.spec.latex
          : block.type === "table"
            ? block.spec.columns.join(" · ")
            : block.type === "chart"
              ? "Chart"
              : "Divider";
    return `${pageTitle || "Untitled page"} · ${block.type}: ${String(text).replace(/\s+/g, " ").slice(0, 180)}`;
  };

  const documentPresentation = (documentId) => {
    const identity = typeof documentId === "string" ? documentId : "";
    return {
      identity,
      title: identity ? `Canvas Note: ${identity}` : "Canvas Note",
    };
  };

  const tableCellText = (value) => {
    return value == null
      ? ""
      : typeof value === "object"
        ? JSON.stringify(value)
        : String(value);
  };

  const selectedReply = (version, selection, records) => {
    const context = { version, blockIds: [...selection] };
    const summaries = context.blockIds.map((id) => {
      const record = records.get(id);
      return blockSummary(record.block, record.pageTitle);
    });
    return {
      context,
      summaries,
      label: `${context.blockIds.length} selected blocks · document version ${context.version}`,
    };
  };

  const replySignature = (context, reply) =>
    JSON.stringify({ ...context, reply });

  const replyMessage = (requestId, context, reply) => ({
    type: "reply",
    requestId,
    ...context,
    reply,
  });

  const websocketUrl = (protocol, host) =>
    `${protocol === "https:" ? "wss:" : "ws:"}//${host}/ws`;

  const parseMessage = (data) => {
    try {
      return { parsed: true, message: JSON.parse(data) };
    } catch {
      return { parsed: false };
    }
  };

  const controlState = ({
    count,
    connected,
    closing,
    pending,
    replyContext,
    version,
  }) => {
    const stale = replyContext && replyContext.version !== version;
    return {
      selectionLabel: `${count} selected`,
      replyDisabled: !count || !connected || closing,
      clearDisabled: !count,
      shutdownDisabled: !connected || closing,
      submitDisabled:
        !connected || closing || !!pending || !replyContext || stale,
      readOnly: !!pending,
      submitLabel: pending ? "Sending…" : "Send reply",
      staleWarning: stale && !pending,
    };
  };

  const blockPresentation = (block) => ({
    revision: JSON.stringify([block.type, block.spec]),
    align: block.align || "left",
    label: `Select ${block.type} block ${block.id}`,
    className: `block-content content-${block.type}`,
  });

  const errorPresentation = (error) => {
    const message = error instanceof Error ? error.message : String(error);
    const text = `Unable to render this block: ${message}`;
    return { message, text };
  };

  const replyFailureText = (message) =>
    `${message || "Reply failed."} Your reply is preserved. If the version is stale, close and reopen this dialog before sending again.`;
  const reconnectDelay = (retry) =>
    Math.min(30000, 750 * 2 ** Math.min(retry, 6));

  (() => {
    const $ = (id) => document.getElementById(id);
    const pagesRoot = $("pages");
    const dialog = $("reply-dialog");
    const selection = new Set();
    const pages = new Map();
    const blocks = new Map();
    let doc = null;
    let socket;
    let connected = false;
    let closing = false;
    let retry = 0;
    let reconnectTimer;
    let replyContext = null;
    let pending = null;
    let lastSubmission = null;

    function send(message) {
      if (socket?.readyState !== WebSocket.OPEN) return false;
      try {
        socket.send(JSON.stringify(message));
        return true;
      } catch {
        return false;
      }
    }

    function updateControls() {
      const next = controlState({
        count: selection.size,
        connected,
        closing,
        pending,
        replyContext,
        version: doc?.version,
      });
      $("selection-count").textContent = next.selectionLabel;
      $("reply").disabled = next.replyDisabled;
      $("clear").disabled = next.clearDisabled;
      $("shutdown").disabled = next.shutdownDisabled;
      $("submit").disabled = next.submitDisabled;
      $("reply-text").readOnly = next.readOnly;
      $("dismiss").disabled = next.readOnly;
      $("cancel").disabled = next.readOnly;
      $("submit").textContent = next.submitLabel;
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

    function reportError(record, error) {
      const { message, text } = errorPresentation(error);
      record.content.replaceChildren();
      const notice = document.createElement("p");
      notice.className = "render-error";
      notice.textContent = text;
      record.content.append(notice);
      if (!record.errorReported) {
        record.renderError = message;
        record.errorVersion = doc.version;
        flushError(record);
      }
    }

    function flushError(record) {
      if (record.renderError && !record.errorReported) {
        record.errorReported = send({
          type: "render:error",
          version: record.errorVersion,
          blockId: record.id,
          message: record.renderError,
        });
      }
    }

    function disposeChart(record) {
      record.observer?.disconnect();
      record.observer = null;
      record.chart?.dispose();
      record.chart = null;
    }

    function render(record, block) {
      const presentation = blockPresentation(block);
      record.element.dataset.align = presentation.align;
      record.checkbox.setAttribute("aria-label", presentation.label);
      if (record.revision === presentation.revision) return;
      const reuseChart = block.type === "chart" && record.chart;
      if (!reuseChart) {
        disposeChart(record);
        record.content.replaceChildren();
      }
      record.revision = presentation.revision;
      record.errorReported = false;
      record.renderError = null;
      record.content.className = presentation.className;
      try {
        switch (block.type) {
          case "text":
            record.content.innerHTML = window.DOMPurify.sanitize(
              window.marked.parse(block.spec.md),
              { SANITIZE_NAMED_PROPS: true },
            );
            break;
          case "math":
            window.katex.render(block.spec.latex, record.content, {
              displayMode: true,
              throwOnError: true,
              trust: false,
              strict: "error",
            });
            break;
          case "table": {
            const table = document.createElement("table");
            const head = table.createTHead().insertRow();
            for (const column of block.spec.columns) {
              const cell = document.createElement("th");
              cell.scope = "col";
              cell.textContent = column;
              head.append(cell);
            }
            const body = table.createTBody();
            for (const row of block.spec.rows) {
              const tr = body.insertRow();
              for (const value of row) {
                tr.insertCell().textContent = tableCellText(value);
              }
            }
            record.content.append(table);
            break;
          }
          case "divider":
            record.content.append(document.createElement("hr"));
            break;
          case "chart":
            if (!record.chart) {
              record.chart = window.echarts.init(record.content);
              record.observer = new ResizeObserver(() =>
                record.chart?.resize(),
              );
              record.observer.observe(record.content);
            }
            record.chart.setOption(block.spec, { notMerge: true });
            break;
          default:
            throw new Error(`Unknown block type: ${block.type}`);
        }
      } catch (error) {
        disposeChart(record);
        reportError(record, error);
      }
    }

    function createBlock(id) {
      const element = document.createElement("section");
      element.className = "block";
      element.dataset.blockId = id;
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.className = "block-select";
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) selection.add(id);
        else selection.delete(id);
        element.classList.toggle("selected", checkbox.checked);
        updateControls();
      });
      const content = document.createElement("div");
      element.append(checkbox, content);
      return { id, element, checkbox, content };
    }

    // Only move nodes that are out of place; unchanged renderers keep their DOM.
    function place(parent, child, index) {
      if (parent.children[index] !== child) {
        parent.insertBefore(child, parent.children[index] || null);
      }
    }

    function reconcile(snapshot) {
      doc = snapshot;
      const livePages = new Set();
      const liveBlocks = new Set();
      snapshot.pages.forEach((page, pageIndex) => {
        livePages.add(page.id);
        let entry = pages.get(page.id);
        if (!entry) {
          const element = document.createElement("article");
          element.className = "page";
          element.dataset.pageId = page.id;
          const title = document.createElement("h1");
          const body = document.createElement("div");
          element.append(title, body);
          entry = { element, title, body };
          pages.set(page.id, entry);
        }
        entry.title.textContent = page.title;
        entry.title.hidden = !page.title;
        place(pagesRoot, entry.element, pageIndex);
        page.blocks.forEach((block, blockIndex) => {
          liveBlocks.add(block.id);
          let record = blocks.get(block.id);
          if (!record) {
            record = createBlock(block.id);
            blocks.set(block.id, record);
          }
          record.block = block;
          record.pageTitle = page.title;
          place(entry.body, record.element, blockIndex);
          render(record, block);
        });
      });
      for (const [id, record] of blocks) {
        if (liveBlocks.has(id)) continue;
        disposeChart(record);
        record.element.remove();
        blocks.delete(id);
        selection.delete(id);
      }
      for (const [id, page] of pages) {
        if (livePages.has(id)) continue;
        page.element.remove();
        pages.delete(id);
      }
      $("empty").hidden = snapshot.pages.length > 0;
      $("empty").textContent =
        "This canvas is empty. New pages will appear here.";
      connected = true;
      retry = 0;
      connectionState("connected", "Connected");
      for (const record of blocks.values()) {
        if (record.renderError) {
          record.errorVersion = doc.version;
          record.errorReported = false;
          flushError(record);
        }
      }
    }

    $("reply").addEventListener("click", () => {
      const selected = selectedReply(doc.version, selection, blocks);
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
      selection.clear();
      for (const record of blocks.values()) {
        record.checkbox.checked = false;
        record.element.classList.remove("selected");
      }
      updateControls();
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
      if (!send({ type: "shutdown" })) {
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
      connectionState("connecting", retry ? "Reconnecting…" : "Connecting…");
      socket = new WebSocket(websocketUrl(location.protocol, location.host));
      socket.addEventListener("open", () => {
        connectionState("connecting", "Syncing…");
      });
      socket.addEventListener("message", (event) => {
        const result = parseMessage(event.data);
        if (!result.parsed) return;
        const message = result.message;
        if (message.type === "server:closing") {
          serverClosing();
        } else if (message.type === "snapshot" && !closing) {
          const presentation = documentPresentation(message.documentId);
          $("document-id").textContent = presentation.identity;
          $("document-id").hidden = !presentation.identity;
          document.title = presentation.title;
          reconcile(message.doc);
        } else if (pending && message.requestId === pending) {
          if (message.type === "ack") {
            pending = null;
            for (const id of replyContext.blockIds) {
              selection.delete(id);
              const record = blocks.get(id);
              if (record) {
                record.checkbox.checked = false;
                record.element.classList.remove("selected");
              }
            }
            $("reply-text").value = "";
            replyContext = null;
            lastSubmission = null;
            dialog.close();
            updateControls();
          } else if (message.type === "error") {
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
      for (const record of blocks.values()) disposeChart(record);
    });
    connect();
  })();
}
