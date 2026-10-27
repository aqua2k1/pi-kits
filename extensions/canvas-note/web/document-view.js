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
import { exportScope } from "./export-scope.js";
import {
  buildPageOutline,
  headingTargetId,
  headingText,
} from "./outline-model.js";
import { createOutlineView } from "./outline-view.js";
import { createSelectionManager } from "./selection-manager.js";

export function createDocumentView({
  staticMode = false,
  initialView = {},
  resources = {},
  events = {},
} = {}) {
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

  function exportMenuPosition(anchor, menu, viewport) {
    const gap = 6;
    const edge = 8;
    return {
      left: Math.max(
        edge,
        Math.min(anchor.right - menu.width, viewport.width - menu.width - edge),
      ),
      top: Math.max(
        edge,
        anchor.bottom + gap + menu.height <= viewport.height - edge
          ? anchor.bottom + gap
          : anchor.top - menu.height - gap,
      ),
    };
  }

  function renderMarkdown(md, headings = []) {
    const parser = new window.marked.Marked(
      window.markedKatex({
        nonStandard: true,
        throwOnError: true,
        trust: false,
        strict: "error",
      }),
    );
    const tokens = parser.lexer(md);
    const markers = new Map();
    const nonce = Math.random().toString(36).slice(2);
    parser.walkTokens(tokens, (token) => {
      if (token.type !== "heading") return;
      const ordinal = headings.length;
      const marker = `${nonce}-${ordinal}`;
      markers.set(token, marker);
      headings.push({
        marker,
        ordinal,
        depth: token.depth,
        label: headingText(token.tokens) || token.text,
      });
    });
    parser.use({
      renderer: {
        heading(token) {
          return `<h${token.depth} data-outline-heading="${markers.get(token)}">${this.parser.parseInline(token.tokens)}</h${token.depth}>\n`;
        },
      },
    });
    return parser.parser(tokens);
  }

  const blockHandlers = defineHandlers(BlockKind, {
    [BlockKind.Text]: {
      ...blockDefinitions[BlockKind.Text],
      copyText: blockDefinitions[BlockKind.Text].summarize,
      render(record, block) {
        const headings = [];
        const html = renderMarkdown(block.spec.md, headings);
        const sanitized = window.DOMPurify.sanitize(html, {
          SANITIZE_NAMED_PROPS: true,
        });
        if (
          staticMode &&
          (sanitized.includes("<img") || sanitized.includes("<picture"))
        ) {
          // Resolve resources while inert, before attaching content to the page.
          const template = document.createElement("template");
          template.innerHTML = sanitized;
          for (const source of template.content.querySelectorAll(
            "picture source",
          ))
            source.remove();
          for (const image of template.content.querySelectorAll("img")) {
            const source = image.getAttribute("src");
            image.removeAttribute("srcset");
            image.removeAttribute("loading");
            if (Object.hasOwn(resources, source))
              image.setAttribute("src", resources[source]);
          }
          record.content.replaceChildren(template.content);
        } else record.content.innerHTML = sanitized;
        const targets = new Map();
        const ordinals = new Map(
          headings.map((heading) => [heading.marker, heading.ordinal]),
        );
        for (const target of record.content.querySelectorAll(
          "[data-outline-heading]",
        )) {
          const ordinal = ordinals.get(
            target.getAttribute("data-outline-heading"),
          );
          if (ordinal === undefined || targets.has(ordinal)) continue;
          target.id = headingTargetId(block.id, ordinal);
          targets.set(ordinal, target);
        }
        record.headings = headings;
        record.headingTargets = targets;
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

  const selectedReply = (version, selection, records, pages = new Map()) => {
    const context = {
      version,
      blockIds: [...selection.blockIds],
      pageIds: [...selection.pageIds],
    };
    const pageSummaries = context.pageIds.map(
      (id) => `Page: ${pages.get(id).page.title || "Untitled page"}`,
    );
    const summaries = context.blockIds.map((id) => {
      const record = records.get(id);
      return blockSummary(record.block, record.pageTitle);
    });
    return {
      context,
      summaries: [...pageSummaries, ...summaries],
      label: `${context.pageIds.length} selected pages · ${context.blockIds.length} selected blocks · document version ${context.version}`,
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

  // Shared local rendering and interactions; no network lifecycle is registered here.
  screenChartTheme = readChartTheme("screen");
  const $ = (id) => document.getElementById(id);
  const pagesRoot = $("pages");
  const outline = $("outline");
  const outlineTree = $("outline-tree");
  const outlineList = $("outline-list");
  const outlineToggle = $("outline-toggle");
  const selectionManager = createSelectionManager();
  const pages = new Map();
  const blocks = new Map();
  let outlineMode =
    initialView.outlineMode === "structure" ? "structure" : "semantic";
  const dirtyOutlinePages = new Set();
  const outlineView = createOutlineView({
    document,
    root: outlineList,
    initialFolds: new Map(initialView.folds || []),
    resolveTarget(target) {
      if (target.kind === "page") return pages.get(target.pageId)?.element;
      const record = blocks.get(target.blockId);
      return target.kind === "heading"
        ? record?.headingTargets?.get(target.ordinal)
        : record?.element;
    },
  });
  const failedBlocks = new Set();
  let doc = null;
  let printScope = null;
  const printMarkers = new Set();
  if (!staticMode)
    selectionManager.subscribe(({ blockIds, pageIds }) => {
      for (const [ids, records, selected] of [
        [blockIds, blocks, (id) => selectionManager.hasBlock(id)],
        [pageIds, pages, (id) => selectionManager.hasPage(id)],
      ]) {
        for (const id of ids) {
          const record = records.get(id);
          if (!record) continue;
          const checked = selected(id);
          record.checkbox.checked = checked;
          if (record.element.classList.contains("selected") !== checked)
            record.element.classList.toggle("selected", checked);
        }
      }
      events.selectionChanged?.();
    });

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
    if (record.renderError && !record.errorReported)
      record.errorReported = events.renderError?.(record) || false;
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
    record.headings = [];
    record.headingTargets = new Map();
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
    element.id = `block-${id}`;
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.className = "block-select";
    if (!staticMode)
      checkbox.addEventListener("change", () => {
        selectionManager.setBlock(id, checkbox.checked);
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

  function syncOutlinePage(pageId) {
    dirtyOutlinePages.add(pageId);
  }

  function syncOutlineBlock(pageId) {
    syncOutlinePage(pageId);
  }

  function removeOutlineBlock(pageId) {
    syncOutlinePage(pageId);
  }

  function flushOutline() {
    for (const pageId of dirtyOutlinePages) {
      const entry = pages.get(pageId);
      if (!entry) {
        selectionManager.removePage(pageId);
        outlineView.removePage(pageId);
        continue;
      }
      outlineView.updatePage(
        buildPageOutline(
          entry.page,
          outlineMode,
          (id) => blocks.get(id)?.headings || [],
        ),
        doc.pages.indexOf(entry.page),
      );
    }
    dirtyOutlinePages.clear();
  }

  function syncOutline() {
    if (!doc) return;
    outlineView.retainPages(new Set(doc.pages.map((page) => page.id)));
    for (const page of doc.pages) syncOutlinePage(page.id);
    flushOutline();
  }

  const modeButtons = [
    ["outline-mode-structure", "structure"],
    ["outline-mode-semantic", "semantic"],
  ];
  for (const [id, mode] of modeButtons) {
    $(id).addEventListener("click", () => {
      if (outlineMode === mode) return;
      outlineMode = mode;
      for (const [buttonId, buttonMode] of modeButtons)
        $(buttonId).setAttribute("aria-pressed", String(mode === buttonMode));
      outlineTree.setAttribute(
        "aria-label",
        mode === "structure" ? "Pages and blocks" : "Pages and headings",
      );
      syncOutline();
    });
  }

  let allExpanded =
    initialView.allExpanded === 0
      ? 0
      : initialView.allExpanded === 1
        ? 1
        : initialView.folds?.some(([, open]) => !open)
          ? 0
          : 1;
  const toggleAll = $("outline-toggle-all");
  function updateToggleAll() {
    toggleAll.textContent = allExpanded ? "Collapse all" : "Expand all";
    toggleAll.dataset.state = String(allExpanded);
    toggleAll.setAttribute("aria-expanded", String(!!allExpanded));
  }
  toggleAll.addEventListener("click", () => {
    allExpanded ^= 1;
    outlineView.setAllExpanded(!!allExpanded);
    updateToggleAll();
  });
  updateToggleAll();

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
  setOutlineCollapsed(initialView.collapsed === true);
  for (const [id, mode] of modeButtons)
    $(id).setAttribute("aria-pressed", String(mode === outlineMode));
  outlineTree.setAttribute(
    "aria-label",
    outlineMode === "structure" ? "Pages and blocks" : "Pages and headings",
  );

  function pageEntry(page) {
    let entry = pages.get(page.id);
    if (!entry) {
      const element = document.createElement("article");
      element.className = "page";
      element.dataset.pageId = page.id;
      element.id = `page-${page.id}`;
      const title = document.createElement("h1");
      const body = document.createElement("div");
      const label = document.createElement("label");
      label.className = "page-selection";
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.className = "page-select";
      const caption = document.createElement("span");
      caption.textContent = "Select page";
      label.append(checkbox, caption);
      if (!staticMode)
        checkbox.addEventListener("change", () => {
          selectionManager.setPage(page.id, checkbox.checked);
        });
      element.append(title, body, label);
      entry = { element, title, body, checkbox };
      pages.set(page.id, entry);
    }
    entry.page = page;
    const label = `Select page ${page.title || "Untitled page"}`;
    if (entry.label !== label) {
      entry.checkbox.setAttribute("aria-label", label);
      entry.label = label;
    }
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
    selectionManager.removeBlock(id);
  }

  function finishUpdate() {
    flushOutline();
    const empty = doc.pages.length === 0;
    if ($("empty").hidden !== !empty) $("empty").hidden = !empty;
    const emptyText = "This canvas is empty. New pages will appear here.";
    if ($("empty").textContent !== emptyText)
      $("empty").textContent = emptyText;
    events.updated?.();
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
      selectionManager.removePage(id);
    }
    syncOutline();
    finishUpdate();
  }

  function updateChartThemes(mode) {
    const changed = chartThemeMode !== mode;
    if (changed && mode === "print") printChartTheme = readChartTheme("print");
    chartThemeMode = mode;
    for (const record of blocks.values()) {
      if (changed)
        record.chart?.setTheme(currentChartTheme(), { silent: true });
      record.chart?.resize({ animation: { duration: 0 } });
      // Printing may capture the canvas before the next animation frame.
      record.chart?.getZr().flush();
    }
  }

  function preparePrintScope(selected = selectionManager.snapshot()) {
    if (printScope || !doc) return;
    printScope = exportScope(doc, selected);
    if (printScope.all) return;
    pagesRoot.classList.toggle("printing-selection", true);
    for (const [index, id] of printScope.pageIds.entries()) {
      const element = pages.get(id)?.element;
      if (!element) continue;
      element.classList.toggle("export-included", true);
      if (index === 0) element.classList.toggle("export-first-page", true);
      printMarkers.add(element);
    }
    for (const id of printScope.blockIds) {
      const element = blocks.get(id)?.element;
      if (!element) continue;
      element.classList.toggle("export-included", true);
      printMarkers.add(element);
    }
  }

  function clearPrintScope() {
    if (!printScope) return;
    if (!printScope.all) pagesRoot.classList.remove("printing-selection");
    for (const element of printMarkers) {
      element.classList.remove("export-included");
      element.classList.remove("export-first-page");
    }
    printMarkers.clear();
    printScope = null;
  }

  window.addEventListener("beforeprint", () => {
    preparePrintScope();
    updateChartThemes("print");
  });
  window.addEventListener("afterprint", () => {
    clearPrintScope();
    updateChartThemes("screen");
  });

  return {
    get doc() {
      return doc;
    },
    pages,
    blocks,
    pagesRoot,
    selectionManager,
    reconcile,
    finishUpdate,
    preparePrintScope,
    clearPrintScope,
    updateChartThemes,
    restoreScreenTheme() {
      if (chartThemeMode === "print") updateChartThemes("screen");
    },
    applyOperations(operations, version) {
      doc.version = version;
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
      for (const operation of operations)
        operationHandlers[operation.type].apply(operation, context);
      finishUpdate();
    },
    snapshotView() {
      return {
        outlineMode,
        collapsed: outline.classList.contains("collapsed"),
        folds: outlineView.snapshotFolds(),
        allExpanded,
      };
    },
    helpers: {
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
    },
  };
}
