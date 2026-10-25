// A standalone read-only snapshot: reuse rendered content, not the live client.
export async function buildHtml({ title, pages, charts, theme }) {
  const output = document.implementation.createHTMLDocument(title);
  output.documentElement.lang = document.documentElement.lang;
  output.head.insertAdjacentHTML(
    "afterbegin",
    '<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">',
  );
  const root = pages.cloneNode(true);
  root.classList.remove("outline-collapsed");
  for (const node of root.querySelectorAll(
    ".block-select, .block-copy, script, picture source",
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
  layout.textContent =
    "@media screen { #pages, #pages.outline-collapsed { margin-left: 0; } .block { padding: .85rem .65rem; } }";
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
  if (snapshots.length) {
    addScript(await resource("/vendor/echarts.js"));
    const data = JSON.stringify({
      charts: snapshots,
      theme: snapshotTheme,
    }).replace(/</g, "\\u003c");
    addScript(`(${restoreCharts.toString()})(${data});`);
  }
  return `<!doctype html>\n${output.documentElement.outerHTML}`;
}

function restoreCharts({ charts, theme }) {
  const instances = [];
  for (const { id, option } of charts) {
    const container = Array.from(
      document.querySelectorAll("[data-export-chart]"),
    ).find((node) => node.dataset.exportChart === id);
    const chart = window.echarts.init(container, theme);
    chart.setOption(option);
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
