import {
  Alignment,
  BlockKind,
  blockDefinitions,
  defineHandlers,
  isAlignment,
  isBlockKind,
  isPageChange,
  MessageKind,
  OperationKind,
  PageChangeKind,
} from "../core/contracts.js";
import { createChartTheme } from "./chart-theme.js";
import { exportHtml } from "./export-html.js";

{
  let chartThemeMode = "screen";
  let screenChartTheme;
  let printChartTheme;

  function readChartTheme(mode) {
    const styles = window.getComputedStyle(document.documentElement);
    const colors = Object.fromEntries(
      ["text", "muted", "border", "surface", "background"]
        .map((key) => [key, styles.getPropertyValue(`--${key}`).trim()])
        .filter(([, value]) => value),
    );
    return createChartTheme(colors, mode);
  }

  const currentChartTheme = () =>
    chartThemeMode === "print" ? printChartTheme : screenChartTheme;

  const openMarkdownLinksInNewTabs = (root) => {
    for (const link of root.querySelectorAll("a")) {
      link.setAttribute("target", "_blank");
      link.setAttribute("rel", "noopener noreferrer");
    }
  };

  function renderMarkdown(md) {
    const parser = new window.marked.Marked(
      window.markedKatex({
        nonStandard: true,
        throwOnError: true,
        trust: false,
        strict: "error",
      }),
    );
    return parser.parse(md);
  }

  const blockHandlers = defineHandlers(BlockKind, {
    [BlockKind.Text]: {
      ...blockDefinitions[BlockKind.Text],
      copyText: blockDefinitions[BlockKind.Text].summarize,
      render(record, block) {
        record.content.innerHTML = window.DOMPurify.sanitize(
          renderMarkdown(block.spec.md),
          { SANITIZE_NAMED_PROPS: true },
        );
        openMarkdownLinksInNewTabs(record.content);
      },
    },
    [BlockKind.Code]: {
      ...blockDefinitions[BlockKind.Code],
      copyText: blockDefinitions[BlockKind.Code].summarize,
      render(record, block) {
        const language = block.spec.language?.trim().toLowerCase();
        if (language) {
          const label = document.createElement("div");
          label.className = "code-language";
          label.textContent = block.spec.language;
          record.content.append(label);
        }
        const pre = document.createElement("pre");
        const code = document.createElement("code");
        code.textContent = block.spec.code;
        if (language && window.hljs?.getLanguage(language)) {
          code.className = "hljs";
          code.innerHTML = window.DOMPurify.sanitize(
            window.hljs.highlight(block.spec.code, { language }).value,
            { ALLOWED_TAGS: ["span"], ALLOWED_ATTR: ["class"] },
          );
        }
        pre.append(code);
        record.content.append(pre);
      },
    },
    [BlockKind.Chart]: {
      ...blockDefinitions[BlockKind.Chart],
      copyText: (spec) => JSON.stringify(spec, null, 2),
      reuse: true,
      render(record, block) {
        if (!record.chart) {
          record.chart = window.echarts.init(
            record.content,
            currentChartTheme(),
          );
          record.observer = new ResizeObserver(() => record.chart?.resize());
          record.observer.observe(record.content);
        }
        record.chart.setOption(block.spec, { notMerge: true });
      },
    },
    [BlockKind.Math]: {
      ...blockDefinitions[BlockKind.Math],
      copyText: blockDefinitions[BlockKind.Math].summarize,
      render(record, block) {
        window.katex.render(block.spec.latex, record.content, {
          displayMode: true,
          throwOnError: true,
          trust: false,
          strict: "error",
        });
      },
    },
    [BlockKind.Table]: {
      ...blockDefinitions[BlockKind.Table],
      copyText: (spec) =>
        [spec.columns, ...spec.rows]
          .map((row) => row.map(tableClipboardCell).join("\t"))
          .join("\n"),
      render(record, block) {
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
      },
    },
    [BlockKind.Divider]: {
      ...blockDefinitions[BlockKind.Divider],
      copyText: () => "---",
      render(record) {
        record.content.append(document.createElement("hr"));
      },
    },
  });

  const blockSummary = (block, pageTitle) => {
    if (!isBlockKind(block.type))
      throw new Error(`Unknown block type: ${block.type}`);
    const text = blockHandlers[block.type].summarize(block.spec);
    return `${pageTitle || "Untitled page"} · ${block.type}: ${String(text).replace(/\s+/g, " ").slice(0, 180)}`;
  };

  const blockLabel = (block) =>
    typeof block.title === "string" && block.title.trim()
      ? block.title
      : block.type;

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

  const tableClipboardCell = (value) => {
    const text = tableCellText(value);
    return /[\t\r\n"]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };

  const blockCopyText = (block) => {
    if (!isBlockKind(block.type))
      throw new Error(`Unknown block type: ${block.type}`);
    return blockHandlers[block.type].copyText(block.spec);
  };

  async function writeClipboard(text) {
    try {
      if (globalThis.navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return;
      }
    } catch {
      // Remote HTTP pages may need the legacy clipboard path instead.
    }
    const activeElement = document.activeElement;
    const selection = window.getSelection?.();
    const ranges = selection
      ? Array.from({ length: selection.rangeCount }, (_, index) =>
          selection.getRangeAt(index).cloneRange(),
        )
      : [];
    const input = document.createElement("textarea");
    input.value = text;
    input.readOnly = true;
    input.style.position = "fixed";
    input.style.opacity = "0";
    document.body.append(input);
    try {
      input.select();
      if (!document.execCommand?.("copy"))
        throw new Error("Clipboard access is unavailable in this browser.");
    } finally {
      input.remove();
      activeElement?.focus({ preventScroll: true });
      if (selection) {
        selection.removeAllRanges();
        for (const range of ranges) selection.addRange(range);
      }
    }
  }

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
    type: MessageKind.Reply,
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
    align: block.align || Alignment.Left,
    label: `Select ${blockLabel(block)} block ${block.id}`,
    className: `block-content content-${block.type}`,
  });

  const validBlock = (block) => {
    if (
      !block ||
      typeof block.id !== "string" ||
      !block.id ||
      (typeof block.title !== "undefined" &&
        (typeof block.title !== "string" || !/\S/.test(block.title))) ||
      !isBlockKind(block.type) ||
      !isAlignment(block.align) ||
      !block.spec ||
      typeof block.spec !== "object" ||
      Array.isArray(block.spec)
    )
      return false;
    try {
      blockHandlers[block.type].validate(block.spec);
      return true;
    } catch {
      return false;
    }
  };

  const operationHandlers = defineHandlers(OperationKind, {
    [OperationKind.CreatePage]: {
      validate(operation, context) {
        const { pageFor, blockPage, validIndex, addedPages } = context;
        const page = operation.page;
        if (
          !page ||
          typeof page.id !== "string" ||
          !page.id ||
          typeof page.title !== "string" ||
          !Array.isArray(page.blocks) ||
          page.blocks.length ||
          pageFor(page.id) ||
          blockPage(page.id) ||
          !validIndex(operation.index, context.pageCount)
        )
          return false;
        addedPages.set(page.id, page);
        context.pageCount++;
        return true;
      },
      apply(operation, context) {
        const { doc, pageEntry, place, pagesRoot, syncOutlinePage } = context;
        const page = { ...operation.page, blocks: [] };
        doc.pages.splice(operation.index, 0, page);
        const entry = pageEntry(page);
        place(pagesRoot, entry.element, operation.index);
        syncOutlinePage(page.id, operation.index);
      },
    },
    [OperationKind.UpdatePage]: {
      validate(operation, context) {
        const {
          pageFor,
          blockPage,
          addedPages,
          addedBlocks,
          removedPages,
          removed,
          lengths,
        } = context;
        const page = pageFor(operation.pageId);
        if (!page || !isPageChange(operation.change)) return false;
        if (operation.change.kind === PageChangeKind.Rename) return true;
        for (const block of page.blocks) {
          if (blockPage(block.id) === page.id) removed.add(block.id);
        }
        for (const [id, pageId] of addedBlocks) {
          if (pageId === page.id) removed.add(id);
        }
        addedPages.delete(page.id);
        removedPages.add(page.id);
        lengths.delete(page.id);
        context.pageCount--;
        return true;
      },
      apply(operation, context) {
        const { doc, pages, blocks, pageEntry, removeBlock, syncOutlinePage } =
          context;
        const entry = pages.get(operation.pageId);
        if (operation.change.kind === PageChangeKind.Rename) {
          const page = entry.page;
          page.title = operation.change.title;
          pageEntry(page);
          for (const block of page.blocks)
            blocks.get(block.id).pageTitle = page.title;
          syncOutlinePage(page.id);
          return;
        }
        for (const block of entry.page.blocks) removeBlock(block.id);
        doc.pages.splice(doc.pages.indexOf(entry.page), 1);
        entry.element.remove();
        pages.delete(operation.pageId);
        syncOutlinePage(operation.pageId);
      },
    },
    [OperationKind.InsertBlocks]: {
      validate(operation, context) {
        const {
          pageFor,
          blockPage,
          validIndex,
          length,
          removed,
          addedBlocks,
          lengths,
        } = context;
        const { pageId, index, blocks: inserted } = operation;
        if (
          !pageFor(pageId) ||
          !Array.isArray(inserted) ||
          !inserted.length ||
          !validIndex(index, length(pageId))
        )
          return false;
        for (const block of inserted) {
          if (!validBlock(block) || blockPage(block.id) || pageFor(block.id))
            return false;
          removed.delete(block.id);
          addedBlocks.set(block.id, pageId);
        }
        lengths.set(pageId, length(pageId) + inserted.length);
        return true;
      },
      apply(operation, context) {
        const { pages, blockRecord, place, render, syncOutlineBlock } = context;
        const entry = pages.get(operation.pageId);
        entry.page.blocks.splice(operation.index, 0, ...operation.blocks);
        operation.blocks.forEach((block, offset) => {
          const index = operation.index + offset;
          const record = blockRecord(block, entry.page);
          place(entry.body, record.element, index);
          render(record, block);
          syncOutlineBlock(operation.pageId, block, index);
        });
      },
    },
    [OperationKind.UpdateBlocks]: {
      validate(operation, context) {
        const { blockPage, removed, lengths, length } = context;
        if (
          !Array.isArray(operation.blocks) ||
          !Array.isArray(operation.removed)
        )
          return false;
        const seen = new Set();
        for (const block of operation.blocks) {
          if (!validBlock(block) || !blockPage(block.id) || seen.has(block.id))
            return false;
          seen.add(block.id);
        }
        for (const id of operation.removed) {
          const pageId = blockPage(id);
          if (!pageId || seen.has(id)) return false;
          seen.add(id);
          removed.add(id);
          lengths.set(pageId, length(pageId) - 1);
        }
        return true;
      },
      apply(operation, context) {
        const {
          blocks,
          pages,
          render,
          removeBlock,
          syncOutlineBlock,
          removeOutlineBlock,
        } = context;
        for (const block of operation.blocks) {
          const record = blocks.get(block.id);
          const page = pages.get(record.pageId).page;
          const index = page.blocks.indexOf(record.block);
          page.blocks[index] = block;
          record.block = block;
          render(record, block);
          syncOutlineBlock(record.pageId, block, index);
        }
        for (const id of operation.removed) {
          const record = blocks.get(id);
          const page = pages.get(record.pageId).page;
          const index = page.blocks.indexOf(record.block);
          page.blocks.splice(index, 1);
          removeOutlineBlock(record.pageId, id);
          removeBlock(id);
        }
      },
    },
  });

  // Preflight only the referenced IDs; never mutate live state for an invalid batch.
  const validOperations = (operations, pages, blocks) => {
    if (!Array.isArray(operations) || !operations.length) return false;
    const addedPages = new Map();
    const addedBlocks = new Map();
    const removedPages = new Set();
    const removed = new Set();
    const lengths = new Map();
    const pageFor = (id) =>
      addedPages.get(id) ||
      (removedPages.has(id) ? undefined : pages.get(id)?.page);
    const blockPage = (id) =>
      removed.has(id)
        ? undefined
        : addedBlocks.get(id) || blocks.get(id)?.pageId;
    const length = (id) => lengths.get(id) ?? pageFor(id)?.blocks.length;
    const validIndex = (index, size) =>
      Number.isInteger(index) && index >= 0 && index <= size;
    const context = {
      pageCount: pages.size,
      addedPages,
      addedBlocks,
      removedPages,
      removed,
      lengths,
      pageFor,
      blockPage,
      length,
      validIndex,
    };
    for (const operation of operations) {
      if (
        !operation ||
        typeof operation !== "object" ||
        !Object.hasOwn(operationHandlers, operation.type) ||
        !operationHandlers[operation.type].validate(operation, context)
      )
        return false;
    }
    return true;
  };
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
    screenChartTheme = readChartTheme("screen");
    const $ = (id) => document.getElementById(id);
    const pagesRoot = $("pages");
    const outline = $("outline");
    const outlineTree = $("outline-tree");
    const outlineList = $("outline-list");
    const outlineToggle = $("outline-toggle");
    const dialog = $("reply-dialog");
    const selection = new Set();
    const pages = new Map();
    const blocks = new Map();
    const outlinePages = new Map();
    const failedBlocks = new Set();
    let doc = null;
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
      $("save-html").disabled =
        exportingHtml || preparingPrint || !doc?.pages.length;
      $("save-html").textContent = exportingHtml ? "Exporting…" : "Save HTML";
      $("save-pdf").disabled =
        exportingHtml || preparingPrint || !doc?.pages.length;
      $("save-pdf").textContent = preparingPrint ? "Preparing…" : "Save PDF";
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
      failedBlocks.add(record.id);
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
          type: MessageKind.RenderError,
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
      if (record.element.dataset.align !== presentation.align) {
        record.element.dataset.align = presentation.align;
      }
      if (record.label !== presentation.label) {
        record.checkbox.setAttribute("aria-label", presentation.label);
        record.label = presentation.label;
      }
      if (record.revision === presentation.revision) return;
      const handler = isBlockKind(block.type)
        ? blockHandlers[block.type]
        : undefined;
      if (!handler?.reuse || !record.chart) {
        disposeChart(record);
        record.content.replaceChildren();
      }
      record.revision = presentation.revision;
      failedBlocks.delete(record.id);
      record.errorReported = false;
      record.renderError = null;
      record.content.className = presentation.className;
      try {
        if (!handler) throw new Error(`Unknown block type: ${block.type}`);
        handler.render(record, block);
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
      const copy = document.createElement("button");
      copy.type = "button";
      copy.className = "block-copy";
      copy.textContent = "Copy";
      copy.title = "Copy block content";
      copy.setAttribute("aria-label", "Copy block content");
      copy.setAttribute("aria-live", "polite");
      copy.addEventListener("click", async (event) => {
        event.stopPropagation();
        const record = blocks.get(id);
        if (!record || copy.disabled) return;
        clearTimeout(record.copyTimer);
        copy.disabled = true;
        try {
          await writeClipboard(blockCopyText(record.block));
          copy.textContent = "Copied";
          copy.title = "Copied to clipboard";
        } catch (error) {
          copy.textContent = "Copy failed";
          copy.title = String(error);
        } finally {
          if (blocks.get(id) === record) {
            copy.disabled = false;
            record.copyTimer = setTimeout(() => {
              copy.textContent = "Copy";
              copy.title = "Copy block content";
              record.copyTimer = null;
            }, 2000);
          }
        }
      });
      element.append(checkbox, content, copy);
      return { id, element, checkbox, content, copy, copyTimer: null };
    }

    // Only move nodes that are out of place; unchanged renderers keep their DOM.
    function place(parent, child, index) {
      if (parent.children[index] !== child) {
        parent.insertBefore(child, parent.children[index] || null);
      }
    }

    function scrollToOutlineTarget(target) {
      target?.scrollIntoView?.({ behavior: "smooth", block: "start" });
    }

    function outlineBlockLabel(block) {
      return blockLabel(block);
    }

    function setOutlinePageExpanded(entry) {
      entry.children.hidden = !entry.expanded;
      entry.toggle.textContent = entry.expanded ? "▾" : "▸";
      entry.toggle.setAttribute("aria-expanded", String(entry.expanded));
      entry.toggle.setAttribute(
        "aria-label",
        `${entry.expanded ? "Collapse" : "Expand"} ${entry.label}`,
      );
    }

    function createOutlinePage(page) {
      const element = document.createElement("li");
      element.className = "outline-page";
      element.dataset.pageId = page.id;
      const row = document.createElement("div");
      row.className = "outline-page-row";
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "outline-page-toggle";
      const link = document.createElement("button");
      link.type = "button";
      link.className = "outline-link outline-page-link";
      const children = document.createElement("ul");
      children.className = "outline-children";
      const entry = {
        pageId: page.id,
        element,
        toggle,
        link,
        children,
        blocks: new Map(),
        expanded: true,
        label: "",
      };
      toggle.addEventListener("click", () => {
        entry.expanded = !entry.expanded;
        setOutlinePageExpanded(entry);
      });
      link.addEventListener("click", () => {
        scrollToOutlineTarget(pages.get(entry.pageId)?.element);
      });
      row.append(toggle, link);
      element.append(row, children);
      setOutlinePageExpanded(entry);
      return entry;
    }

    function createOutlineBlock(block, pageId) {
      const element = document.createElement("li");
      element.className = "outline-block";
      element.dataset.blockId = block.id;
      const link = document.createElement("button");
      link.type = "button";
      link.className = "outline-link outline-block-link";
      link.addEventListener("click", () => {
        scrollToOutlineTarget(blocks.get(block.id)?.element);
      });
      element.append(link);
      return { pageId, element, link, label: "" };
    }

    function syncOutlinePageEntry(pageId, pageIndex) {
      const pageEntry = pages.get(pageId);
      if (!pageEntry) {
        const stale = outlinePages.get(pageId);
        stale?.element.remove();
        outlinePages.delete(pageId);
        return;
      }
      let entry = outlinePages.get(pageId);
      if (!entry) {
        entry = createOutlinePage(pageEntry.page);
        outlinePages.set(pageId, entry);
      }
      const pageLabel = pageEntry.page.title || "Untitled page";
      if (entry.label !== pageLabel) {
        entry.label = pageLabel;
        entry.link.textContent = pageLabel;
        entry.link.setAttribute("aria-label", `Go to ${pageLabel}`);
        setOutlinePageExpanded(entry);
      }
      const index = pageIndex ?? doc.pages.indexOf(pageEntry.page);
      if (index >= 0) place(outlineList, entry.element, index);
      return entry;
    }

    function syncOutlineBlock(pageId, block, blockIndex) {
      const pageEntry = pages.get(pageId);
      const entry = syncOutlinePageEntry(pageId);
      if (!pageEntry || !entry) return;
      let blockEntry = entry.blocks.get(block.id);
      if (!blockEntry) {
        blockEntry = createOutlineBlock(block, pageId);
        entry.blocks.set(block.id, blockEntry);
      }
      const label = outlineBlockLabel(block);
      if (blockEntry.label !== label) {
        blockEntry.label = label;
        blockEntry.link.textContent = label;
      }
      const ariaLabel = `Go to ${entry.label}, ${label}`;
      if (blockEntry.ariaLabel !== ariaLabel) {
        blockEntry.ariaLabel = ariaLabel;
        blockEntry.link.setAttribute("aria-label", ariaLabel);
      }
      const index = blockIndex ?? pageEntry.page.blocks.indexOf(block);
      if (index >= 0) place(entry.children, blockEntry.element, index);
    }

    function removeOutlineBlock(pageId, blockId) {
      const entry = outlinePages.get(pageId);
      const blockEntry = entry?.blocks.get(blockId);
      if (!blockEntry) return;
      blockEntry.element.remove();
      entry.blocks.delete(blockId);
    }

    function syncOutlinePage(pageId, pageIndex) {
      const pageEntry = pages.get(pageId);
      const entry = syncOutlinePageEntry(pageId, pageIndex);
      if (!pageEntry || !entry) return;
      const liveBlocks = new Set();
      pageEntry.page.blocks.forEach((block, blockIndex) => {
        liveBlocks.add(block.id);
        syncOutlineBlock(pageId, block, blockIndex);
      });
      for (const [id] of entry.blocks) {
        if (!liveBlocks.has(id)) removeOutlineBlock(pageId, id);
      }
    }

    function syncOutline() {
      if (!doc) return;
      const livePages = new Set();
      doc.pages.forEach((page, pageIndex) => {
        livePages.add(page.id);
        syncOutlinePage(page.id, pageIndex);
      });
      for (const [id, entry] of outlinePages) {
        if (livePages.has(id)) continue;
        entry.element.remove();
        outlinePages.delete(id);
      }
    }

    function setOutlineCollapsed(collapsed) {
      outline.classList.toggle("collapsed", collapsed);
      outlineTree.hidden = collapsed;
      pagesRoot.classList.toggle("outline-collapsed", collapsed);
      outlineToggle.textContent = collapsed ? "›" : "‹";
      outlineToggle.setAttribute("aria-expanded", String(!collapsed));
      outlineToggle.setAttribute(
        "aria-label",
        collapsed ? "Expand contents" : "Collapse contents",
      );
    }

    outlineToggle.addEventListener("click", () => {
      setOutlineCollapsed(!outline.classList.contains("collapsed"));
    });
    setOutlineCollapsed(false);

    function pageEntry(page) {
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
      entry.page = page;
      if (entry.title.textContent !== page.title)
        entry.title.textContent = page.title;
      if (entry.title.hidden !== !page.title) entry.title.hidden = !page.title;
      return entry;
    }

    function blockRecord(block, page) {
      let record = blocks.get(block.id);
      if (!record) {
        record = createBlock(block.id);
        blocks.set(block.id, record);
      }
      record.block = block;
      record.pageId = page.id;
      record.pageTitle = page.title;
      return record;
    }

    function removeBlock(id) {
      const record = blocks.get(id);
      clearTimeout(record.copyTimer);
      disposeChart(record);
      record.element.remove();
      blocks.delete(id);
      failedBlocks.delete(id);
      selection.delete(id);
    }

    function finishUpdate() {
      const empty = doc.pages.length === 0;
      if ($("empty").hidden !== !empty) $("empty").hidden = !empty;
      const emptyText = "This canvas is empty. New pages will appear here.";
      if ($("empty").textContent !== emptyText)
        $("empty").textContent = emptyText;
      connected = true;
      retry = 0;
      connectionState("connected", "Connected");
      for (const id of failedBlocks) {
        const record = blocks.get(id);
        if (record.errorVersion !== doc.version) {
          record.errorVersion = doc.version;
          record.errorReported = false;
        }
        flushError(record);
      }
    }

    // Full snapshots are only the bootstrap/recovery path. Reuse stable instances.
    function reconcile(snapshot) {
      doc = snapshot;
      const livePages = new Set();
      const liveBlocks = new Set();
      snapshot.pages.forEach((page, pageIndex) => {
        livePages.add(page.id);
        const entry = pageEntry(page);
        place(pagesRoot, entry.element, pageIndex);
        page.blocks.forEach((block, index) => {
          liveBlocks.add(block.id);
          const record = blockRecord(block, page);
          place(entry.body, record.element, index);
          render(record, block);
        });
      });
      for (const id of blocks.keys()) {
        if (!liveBlocks.has(id)) removeBlock(id);
      }
      for (const [id, entry] of pages) {
        if (livePages.has(id)) continue;
        entry.element.remove();
        pages.delete(id);
      }
      syncOutline();
      awaitingSnapshot = false;
      finishUpdate();
    }

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
        !doc ||
        message.documentId !== documentId ||
        message.baseVersion !== doc.version ||
        message.version !== message.baseVersion + 1 ||
        !validOperations(message.operations, pages, blocks)
      ) {
        requestSnapshot();
        return;
      }
      doc.version = message.version;
      const context = {
        doc,
        pages,
        blocks,
        pagesRoot,
        pageEntry,
        blockRecord,
        place,
        render,
        removeBlock,
        syncOutlinePage,
        syncOutlineBlock,
        removeOutlineBlock,
      };
      for (const operation of message.operations) {
        operationHandlers[operation.type].apply(operation, context);
      }
      finishUpdate();
    }

    function updateChartThemes(mode) {
      const changed = chartThemeMode !== mode;
      if (changed && mode === "print")
        printChartTheme = readChartTheme("print");
      chartThemeMode = mode;
      for (const record of blocks.values()) {
        if (changed)
          record.chart?.setTheme(currentChartTheme(), { silent: true });
        record.chart?.resize({ animation: { duration: 0 } });
        // Printing may capture the canvas before the next animation frame.
        record.chart?.getZr().flush();
      }
    }

    window.addEventListener("beforeprint", () => updateChartThemes("print"));
    window.addEventListener("afterprint", () => updateChartThemes("screen"));
    $("save-html").addEventListener("click", async () => {
      if (exportingHtml || preparingPrint || !doc?.pages.length) return;
      exportingHtml = true;
      $("export-status").textContent = "";
      updateControls();
      try {
        await exportHtml({
          title: document.title,
          pages: pagesRoot,
          charts: doc.pages.flatMap((page) =>
            page.blocks
              .filter(
                (block) =>
                  block.type === BlockKind.Chart && blocks.get(block.id)?.chart,
              )
              .map((block) => ({ id: block.id, option: block.spec })),
          ),
          theme: screenChartTheme,
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
      if (exportingHtml || preparingPrint || !doc?.pages.length) return;
      preparingPrint = true;
      $("save-pdf").title = "";
      updateControls();
      try {
        await Promise.all([
          document.fonts?.ready,
          ...Array.from(pagesRoot.querySelectorAll("img"), (image) =>
            image.decode?.().catch(() => {}),
          ),
        ]);
        window.print();
      } catch (error) {
        $("save-pdf").title = `Print failed: ${String(error)}`;
      } finally {
        preparingPrint = false;
        updateControls();
      }
    });

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
          reconcile(message.doc);
        } else if (message.type === MessageKind.Operations && !closing) {
          consumeOperations(message);
        } else if (pending && message.requestId === pending) {
          if (message.type === MessageKind.Ack) {
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
      for (const record of blocks.values()) disposeChart(record);
    });
    connect();
  })();
}
