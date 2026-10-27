// A standalone read-only snapshot: reuse rendered content, not the live client.
export async function buildHtml({ title, pages, outline, charts, theme }) {
  const output = document.implementation.createHTMLDocument(title);
  output.documentElement.lang = document.documentElement.lang;
  output.head.insertAdjacentHTML(
    "afterbegin",
    '<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">',
  );
  const root = pages.cloneNode(true);
  const sidebar = outline?.cloneNode(true);
  if (!sidebar) root.classList.remove("outline-collapsed");
  if (sidebar) {
    // Export the active outline snapshot, not inert online view controls.
    sidebar.querySelector("#outline-mode")?.remove();
    const targets = new Map();
    for (const node of root.querySelectorAll(
      "[data-page-id], [data-block-id]",
    )) {
      const key = node.dataset.blockId
        ? `block-${node.dataset.blockId}`
        : `page-${node.dataset.pageId}`;
      node.id = `canvas-${key}`;
      targets.set(key, node.id);
    }
    const headingTargets = new Set(
      Array.from(
        root.querySelectorAll("[data-outline-heading]"),
        (node) => node.id,
      ),
    );
    for (const button of sidebar.querySelectorAll(".outline-link")) {
      const block = button.closest(".outline-block");
      const key = block
        ? `block-${block.dataset.blockId}`
        : `page-${button.closest(".outline-page").dataset.pageId}`;
      const target = headingTargets.has(button.dataset.targetId)
        ? button.dataset.targetId
        : targets.get(key);
      if (!target) continue;
      const link = output.createElement("a");
      link.className = button.className;
      link.textContent = button.textContent;
      link.href = `#${encodeURIComponent(target)}`;
      link.setAttribute(
        "aria-label",
        button.getAttribute("aria-label") || button.textContent,
      );
      button.replaceWith(link);
    }
    output.body.append(sidebar);
  }
  for (const node of root.querySelectorAll(
    ".block-select, .page-selection, .block-copy, script, picture source",
  ))
    node.remove();
  for (const node of root.querySelectorAll(".selected"))
    node.classList.remove("selected");
  const snapshots = charts.map(({ id, option }) => ({
    id,
    option: JSON.parse(JSON.stringify(option)),
  }));
  const snapshotTheme = JSON.parse(JSON.stringify(theme));
  for (const { id } of snapshots) {
    const block = Array.from(root.querySelectorAll("[data-block-id]")).find(
      (node) => node.dataset.blockId === id,
    );
    const container = block.querySelector(".block-content");
    container.replaceChildren();
    container.removeAttribute("_echarts_instance_");
    container.removeAttribute("style");
    container.dataset.exportChart = id;
  }
  output.body.append(root);

  const requests = new Map();
  async function resource(url, binary = false) {
    const absolute = new URL(url, location.href).href;
    const key = `${binary}:${absolute}`;
    if (!requests.has(key)) {
      requests.set(
        key,
        (async () => {
          const response = await fetch(absolute);
          if (!response.ok)
            throw new Error(`Cannot embed ${absolute}: ${response.status}`);
          if (!binary) return response.text();
          const blob = await response.blob();
          return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(reader.error);
            reader.readAsDataURL(blob);
          });
        })(),
      );
    }
    return requests.get(key);
  }
  async function embed(url, base = location.href) {
    if (/^(data:|#)/i.test(url)) return url;
    return resource(new URL(url, base).href, true);
  }
  async function inlineCss(css, base) {
    const pattern = /url\(\s*(["']?)([^"')]+)\1\s*\)/gi;
    const matches = [...css.matchAll(pattern)];
    const values = await Promise.all(
      matches.map((match) => embed(match[2].trim(), base)),
    );
    let index = 0;
    return css.replace(pattern, () => `url("${values[index++]}")`);
  }
  for (const link of document.querySelectorAll('link[rel="stylesheet"]')) {
    const style = output.createElement("style");
    style.media = link.media;
    style.textContent = (
      await inlineCss(await resource(link.href), link.href)
    ).replace(/</g, "\\3c ");
    output.head.append(style);
  }
  const layout = output.createElement("style");
  layout.textContent = `@media screen {
      :root { --toolbar-height: 0px; }
      html { scroll-behavior: smooth; }
      ${sidebar ? "" : "#pages, #pages.outline-collapsed { margin-left: 0; }"}
      .block { padding: .85rem .65rem; }
      .page, .block, [data-outline-heading] { scroll-margin-top: 1.5rem; }
      .outline-link { text-decoration: none; }
    }`;
  output.head.append(layout);
  await Promise.all(
    Array.from(root.querySelectorAll("img"), async (image) => {
      image.src = await embed(image.getAttribute("src"));
      image.removeAttribute("srcset");
      image.removeAttribute("loading");
    }),
  );
  // ECharts image symbols and image graphics must also work without a server.
  async function inlineChartImages(value) {
    if (!value || typeof value !== "object") return;
    await Promise.all(
      Object.entries(value).map(async ([key, item]) => {
        if (typeof item === "string" && item.startsWith("image://"))
          value[key] = `image://${await embed(item.slice(8))}`;
        else if (key === "image" && typeof item === "string")
          value[key] = await embed(item);
        else await inlineChartImages(item);
      }),
    );
  }
  await inlineChartImages(snapshots);
  function addScript(source) {
    const script = output.createElement("script");
    script.textContent = source.replace(/<\/script/gi, "<\\/script");
    output.body.append(script);
  }
  if (snapshots.length) addScript(await resource("/vendor/echarts.js"));
  if (snapshots.length || sidebar) {
    const data = JSON.stringify({
      charts: snapshots,
      theme: snapshotTheme,
    }).replace(/</g, "\\u003c");
    addScript(`(${restoreDocument.toString()})(${data});`);
  }
  return `<!doctype html>\n${output.documentElement.outerHTML}`;
}

function restoreDocument({ charts, theme }) {
  const outline = document.getElementById("outline");
  if (outline) {
    const tree = document.getElementById("outline-tree");
    const toggle = document.getElementById("outline-toggle");
    toggle.addEventListener("click", () => {
      const collapsed = outline.classList.toggle("collapsed");
      tree.hidden = collapsed;
      document
        .getElementById("pages")
        .classList.toggle("outline-collapsed", collapsed);
      toggle.textContent = collapsed ? "›" : "‹";
      toggle.setAttribute("aria-expanded", String(!collapsed));
      toggle.setAttribute(
        "aria-label",
        collapsed ? "Expand contents" : "Collapse contents",
      );
    });
    function setExpanded(button, open) {
      const entry = button.closest("li");
      const children = Array.from(entry.children).find((node) =>
        node.classList.contains("outline-children"),
      );
      if (!children) return;
      children.hidden = !open;
      button.textContent = open ? "▾" : "▸";
      button.setAttribute("aria-expanded", String(open));
      button.setAttribute(
        "aria-label",
        `${open ? "Collapse" : "Expand"} ${entry.querySelector(".outline-link").textContent}`,
      );
    }
    const buttons = outline.querySelectorAll(".outline-page-toggle");
    for (const button of buttons) {
      button.addEventListener("click", () => {
        setExpanded(button, button.getAttribute("aria-expanded") !== "true");
      });
    }
    for (const [id, open] of [
      ["outline-expand-all", true],
      ["outline-collapse-all", false],
    ]) {
      document.getElementById(id)?.addEventListener("click", () => {
        for (const button of buttons) setExpanded(button, open);
      });
    }
  }
  const instances = [];
  for (const { id, option } of charts) {
    const container = Array.from(
      document.querySelectorAll("[data-export-chart]"),
    ).find((node) => node.dataset.exportChart === id);
    const chart = window.echarts.init(container, theme);
    chart.setOption(option);
    new ResizeObserver(() => chart.resize()).observe(container);
    instances.push(chart);
  }
  const resize = () => {
    for (const chart of instances) chart.resize();
  };
  window.addEventListener("resize", resize);
  document.fonts?.ready.then(resize);
}

export async function exportHtml(options) {
  const html = await buildHtml(options);
  const url = URL.createObjectURL(
    new Blob([html], { type: "text/html;charset=utf-8" }),
  );
  const link = document.createElement("a");
  link.href = url;
  const filename = Array.from(options.title, (char) =>
    char.charCodeAt(0) < 32 || /[\\/:*?"<>|]/.test(char) ? "_" : char,
  ).join("");
  link.download = `${filename || "canvas-note"}.html`;
  document.body.append(link);
  try {
    link.click();
  } finally {
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
