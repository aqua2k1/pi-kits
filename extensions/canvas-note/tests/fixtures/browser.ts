import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { Marked, type MarkedExtension, type TokensList } from "marked";
import markedKatex from "marked-katex-extension";
import type { Document, Operation } from "../../core/model.ts";
import { clientGlobals, clientScript } from "./client-script.ts";

const require = createRequire(import.meta.url);
const hljs = runInNewContext(
  `${readFileSync(require.resolve("@highlightjs/cdn-assets/highlight.min.js"), "utf8")}\nhljs;`,
);

type Listener = (event: Record<string, unknown>) => void;

class Events {
  private listeners = new Map<string, Listener[]>();

  addEventListener(type: string, listener: Listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  emit(type: string, event: Record<string, unknown> = {}) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ preventDefault() {}, stopPropagation() {}, ...event });
    }
  }
}

// Count setter invocations even if the assigned value is unchanged. A browser
// still observes those writes; checking final HTML alone would miss regressions.
export class Element extends Events {
  readonly writes: Record<string, number> = {};
  readonly children: Element[] = [];
  parentNode: Element | null = null;
  private values: Record<string, unknown> = {};
  readonly dataset = this.tracked("dataset");
  readonly style = this.tracked("style");
  readonly attributes: Record<string, string> = {};
  readonly classList = {
    toggle: (name: string, force?: boolean) => {
      const names = new Set(this.className.split(/\s+/).filter(Boolean));
      const enabled = force ?? !names.has(name);
      if (enabled) names.add(name);
      else names.delete(name);
      this.className = [...names].join(" ");
      return enabled;
    },
    remove: (name: string) => this.classList.toggle(name, false),
    contains: (name: string) => this.className.split(/\s+/).includes(name),
  };
  checked = false;
  disabled = false;
  readOnly = false;
  open = false;
  value = "";
  type = "";
  scope = "";
  id = "";

  constructor(readonly tagName: string) {
    super();
  }

  private count(operation: string) {
    this.writes[operation] = (this.writes[operation] ?? 0) + 1;
  }

  private tracked(name: string): Record<string, string> {
    return new Proxy<Record<string, string>>(
      {},
      {
        set: (target, key: string, value: string) => {
          this.count(`${name}.${key}`);
          target[key] = value;
          return true;
        },
      },
    );
  }

  get textContent(): string {
    return String(this.values.textContent ?? "");
  }
  set textContent(value: string) {
    this.count("textContent");
    this.detachChildren();
    this.values.textContent = value;
  }
  get innerHTML(): string {
    return String(this.values.innerHTML ?? "");
  }
  set innerHTML(value: string) {
    this.count("innerHTML");
    this.detachChildren();
    this.values.innerHTML = value;
    // Materialize generated Markdown heading anchors without simulating an HTML DOM.
    for (const match of value.matchAll(
      /<h([1-6])\b([^>]*)>([\s\S]*?)<\/h\1>/g,
    )) {
      if (!match[2].includes("data-outline-heading")) continue;
      const heading = new Element(`h${match[1]}`);
      heading.textContent = match[3]
        .replace(/<[^>]*>/g, "")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'");
      for (const attribute of match[2].matchAll(/([\w-]+)="([^"]*)"/g)) {
        heading.setAttribute(attribute[1], attribute[2]);
        if (attribute[1] === "id") heading.id = attribute[2];
        if (attribute[1] === "data-outline-heading")
          heading.dataset.outlineHeading = attribute[2];
      }
      this.append(heading);
    }
  }
  get className(): string {
    return String(this.values.className ?? "");
  }
  set className(value: string) {
    this.count("className");
    this.values.className = value;
  }
  get hidden(): boolean {
    return Boolean(this.values.hidden);
  }
  set hidden(value: boolean) {
    this.count("hidden");
    this.values.hidden = value;
  }
  get firstChild() {
    return this.children[0] ?? null;
  }
  get nextSibling(): Element | null {
    if (!this.parentNode) return null;
    return (
      this.parentNode.children[this.parentNode.children.indexOf(this) + 1] ??
      null
    );
  }

  setAttribute(name: string, value: string) {
    this.count(`attribute.${name}`);
    this.attributes[name] = value;
  }

  getAttribute(name: string) {
    return this.attributes[name] ?? null;
  }

  private detachChildren() {
    for (const child of this.children) child.parentNode = null;
    this.children.length = 0;
  }

  private detach() {
    if (!this.parentNode) return;
    const siblings = this.parentNode.children;
    siblings.splice(siblings.indexOf(this), 1);
    this.parentNode = null;
  }

  insertBefore(child: Element, reference: Element | null) {
    this.count("insertBefore");
    assert.ok(reference === null || this.children.includes(reference));
    if (child === reference) return child;
    child.detach();
    const index =
      reference === null
        ? this.children.length
        : this.children.indexOf(reference);
    this.children.splice(index, 0, child);
    child.parentNode = this;
    return child;
  }

  append(...children: Element[]) {
    this.count("append");
    for (const child of children) this.insertBefore(child, null);
  }

  appendChild(child: Element) {
    return this.insertBefore(child, null);
  }

  replaceChildren(...children: Element[]) {
    this.count("replaceChildren");
    this.detachChildren();
    for (const child of children) this.insertBefore(child, null);
  }

  remove() {
    this.count("remove");
    this.detach();
  }

  showModal() {
    this.open = true;
  }
  close() {
    this.open = false;
  }
  focus() {}
  select() {
    this.count("select");
  }
  scrollIntoView() {
    this.count("scrollIntoView");
  }
  querySelectorAll(selector: string) {
    return subtree(this)
      .slice(1)
      .filter((node) =>
        selector.split(",").some((part) => {
          const tag = part.trim();
          if (tag === "[data-outline-heading]")
            return node.dataset.outlineHeading !== undefined;
          if (tag === "[id]") return !!node.id;
          if (tag.startsWith(".")) return node.classList.contains(tag.slice(1));
          return node.tagName === tag;
        }),
      );
  }

  createTHead() {
    return this.add("thead");
  }
  createTBody() {
    return this.add("tbody");
  }
  insertRow() {
    return this.add("tr");
  }
  insertCell() {
    return this.add("td");
  }
  private add(tag: string) {
    const child = new Element(tag);
    this.append(child);
    return child;
  }
}

export function subtree(node: Element): Element[] {
  return [node, ...node.children.flatMap(subtree)];
}

export function writeCount(nodes: Element[]) {
  return nodes.reduce(
    (sum, node) => sum + Object.values(node.writes).reduce((a, b) => a + b, 0),
    0,
  );
}

export function browser() {
  const nodes: Element[] = [];
  const createElement = (tag: string) => {
    const node = new Element(tag);
    nodes.push(node);
    return node;
  };
  const body = createElement("body");
  const clipboard = {
    texts: [] as string[],
    fail: false,
    legacyAvailable: true,
    legacyCalls: 0,
  };
  const printing = { calls: 0, fail: false, active: false };
  const themeColors: Record<string, Record<string, string>> = {
    screen: {
      text: "#ebdbb2",
      muted: "#a89984",
      border: "#665c54",
      surface: "#282828",
      background: "#1d2021",
    },
    print: {
      text: "#222",
      muted: "#555",
      border: "#aaa",
      surface: "#fff",
      background: "#fff",
    },
  };
  const fonts = { ready: Promise.resolve() };
  const ids = new Map<string, Element>();
  const html = readFileSync(
    new URL("../../web/client.html", import.meta.url),
    "utf8",
  );
  for (const match of html.matchAll(/<([\w-]+)[^>]*\bid="([^"]+)"/g)) {
    ids.set(match[2], createElement(match[1]));
  }
  const get = (id: string) => {
    const node = ids.get(id);
    assert.ok(node, `Missing HTML element #${id}`);
    return node;
  };
  const timers = new Map<number, () => void>();
  let timerId = 0;
  class Socket extends Events {
    static OPEN = 1;
    readyState = Socket.OPEN;
    failSend = false;
    sent: {
      type: string;
      version?: number;
      blockId?: string;
      blockIds?: string[];
      pageIds?: string[];
      requestId?: string;
      message?: string;
      reply?: string;
    }[] = [];
    constructor(readonly url: string) {
      super();
      sockets.push(this);
    }
    send(data: string) {
      if (this.failSend) throw new Error("transport unavailable");
      this.sent.push(JSON.parse(data));
    }
    close() {
      this.readyState = 3;
      this.emit("close");
    }
  }
  const sockets: Socket[] = [];
  const markdown: string[] = [];
  const sanitized: string[] = [];
  const math: string[] = [];
  const charts: {
    element: Element;
    options: unknown[];
    disposed: number;
    resizes: number;
    flushes: number;
    getZr(): { flush(): void };
    initialTheme: unknown;
    themes: unknown[];
    setTheme(theme: unknown): void;
    setOption(option: unknown): void;
    dispose(): void;
    resize(): void;
  }[] = [];
  const observers: Observer[] = [];
  class Observer {
    disconnected = 0;
    targets: Element[] = [];
    constructor(readonly callback: () => void) {
      observers.push(this);
    }
    observe(element: Element) {
      this.targets.push(element);
    }
    disconnect() {
      this.disconnected++;
    }
  }
  const window = Object.assign(new Events(), {
    getComputedStyle() {
      return {
        getPropertyValue(key: string) {
          return (
            themeColors[printing.active ? "print" : "screen"][
              key.replace(/^--/, "")
            ] ?? ""
          );
        },
      };
    },
    hljs,
    markedKatex,
    marked: {
      Marked: class {
        private actual: Marked;
        private sources = new WeakMap<TokensList, string>();
        constructor(...extensions: MarkedExtension[]) {
          this.actual = new Marked(...extensions);
        }
        use(...extensions: MarkedExtension[]) {
          this.actual.use(...extensions);
          return this;
        }
        lexer(md: string) {
          markdown.push(md);
          if (md === "BROKEN") throw new Error("invalid markdown");
          const tokens = this.actual.lexer(md);
          this.sources.set(tokens, md);
          return tokens;
        }
        parser(tokens: TokensList) {
          const html = this.actual.parser(tokens);
          // Preserve legacy fixture rendering for tests unrelated to headings.
          return html.includes("data-outline-heading")
            ? html
            : `<p>${this.sources.get(tokens) ?? ""}</p>`;
        }
        parse(md: string) {
          return this.parser(this.lexer(md));
        }
        walkTokens(...args: Parameters<Marked["walkTokens"]>) {
          return this.actual.walkTokens(...args);
        }
      },
    },
    DOMPurify: {
      sanitize(html: string) {
        sanitized.push(html);
        return html;
      },
    },
    katex: {
      render(latex: string, element: Element) {
        math.push(latex);
        element.textContent = latex;
      },
    },
    echarts: {
      init(element: Element, theme: unknown) {
        const chart = {
          element,
          initialTheme: theme,
          themes: [] as unknown[],
          setTheme(value: unknown) {
            this.themes.push(value);
          },
          options: [] as unknown[],
          disposed: 0,
          resizes: 0,
          flushes: 0,
          getZr() {
            return {
              flush: () => {
                this.flushes++;
              },
            };
          },
          setOption(option: unknown) {
            this.options.push(option);
          },
          dispose() {
            this.disposed++;
          },
          resize() {
            this.resizes++;
          },
        };
        charts.push(chart);
        return chart;
      },
    },
  });
  Object.assign(window, {
    print() {
      printing.calls++;
      if (printing.fail) throw new Error("printing unavailable");
      printing.active = true;
      window.emit("beforeprint");
      window.emit("afterprint");
      printing.active = false;
    },
  });
  // Run the entire client including its startup IIFE, binding its static ESM
  // import to the real shared module. No runtime helpers are replaced or called.
  runInNewContext(
    clientScript(
      readFileSync(new URL("../../web/client.js", import.meta.url), "utf8"),
    ),
    {
      ...clientGlobals,
      document: {
        getElementById: get,
        createElement,
        title: "Canvas Note",
        documentElement: createElement("html"),
        fonts,
        body,
        execCommand(command: string) {
          assert.equal(command, "copy");
          clipboard.legacyCalls++;
          if (!clipboard.legacyAvailable) return false;
          clipboard.texts.push(body.children.at(-1)?.value ?? "");
          return true;
        },
      },
      navigator: {
        clipboard: {
          async writeText(text: string) {
            if (clipboard.fail) throw new Error("clipboard denied");
            clipboard.texts.push(text);
          },
        },
      },
      window,
      WebSocket: Socket,
      ResizeObserver: Observer,
      location: { protocol: "http:", host: "canvas.test" },
      crypto: { randomUUID: () => "test-request" },
      setTimeout(callback: () => void) {
        timers.set(++timerId, callback);
        return timerId;
      },
      clearTimeout(id: number) {
        timers.delete(id);
      },
    },
    { filename: "web/client.js" },
  );
  const socket = () => {
    const current = sockets.at(-1);
    assert.ok(current);
    return current;
  };
  const find = (key: "pageId" | "blockId", id: string) => {
    const node = subtree(get("pages")).find((node) => node.dataset[key] === id);
    assert.ok(node, `Missing ${key}=${id}`);
    return node;
  };
  const message = (data: unknown) => {
    socket().emit("message", { data: JSON.stringify(data) });
  };
  const runReconnect = () => {
    const scheduled = [...timers.values()];
    timers.clear();
    assert.equal(scheduled.length, 1);
    scheduled[0]();
    socket().emit("open");
  };
  return {
    get,
    message,
    operations(baseVersion: number, operations: Operation[]) {
      message({
        type: "operations",
        documentId: "test-document",
        baseVersion,
        version: baseVersion + 1,
        operations,
      });
    },
    runReconnect,
    socket,
    sockets,
    markdown,
    sanitized,
    math,
    charts,
    observers,
    window,
    clipboard,
    printing,
    themeColors,
    fonts,
    body,
    runTimers() {
      for (const fn of [...timers.values()]) fn();
      timers.clear();
    },
    page: (id: string) => find("pageId", id),
    block: (id: string) => find("blockId", id),
    snapshot(doc: Document) {
      message({ type: "snapshot", documentId: "test-document", doc });
    },
    resetWrites() {
      for (const node of new Set(nodes.flatMap(subtree)))
        for (const key of Object.keys(node.writes)) delete node.writes[key];
    },
    reconnect() {
      if (socket().readyState !== 3) socket().close();
      runReconnect();
    },
  };
}
