/**
 * Encode shared ESM modules as an inline import map, preserving their real imports.
 * @param {string} entryUrl
 * @param {(url: string) => Promise<string>} readResource
 * @returns {Promise<{ entry: string, imports: Record<string, string> }>}
 */
export async function bundleModules(entryUrl, readResource) {
  const keys = new Map();
  const sources = new Map();
  async function visit(url) {
    if (keys.has(url)) return keys.get(url);
    const key = `canvas-note${new URL(url).pathname}`;
    keys.set(url, key);
    const source = await readResource(url);
    const imports = [
      ...source.matchAll(
        /^(\s*(?:import|export)\s+(?:[^;"']+?\s+from\s*)?)(["'])([^"']+)\2/gm,
      ),
    ];
    const replacements = await Promise.all(
      imports.map(async (match) => ({
        start: match.index,
        end: match.index + match[0].length,
        text: `${match[1]}${JSON.stringify(await visit(new URL(match[3], url).href))}`,
      })),
    );
    let rewritten = source;
    for (const replacement of replacements.reverse())
      rewritten =
        rewritten.slice(0, replacement.start) +
        replacement.text +
        rewritten.slice(replacement.end);
    sources.set(key, rewritten);
    return key;
  }
  const entry = await visit(entryUrl);
  /** @type {Record<string, string>} */
  const imports = {};
  for (const [key, source] of sources) {
    const bytes = new TextEncoder().encode(source);
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    imports[key] = `data:text/javascript;base64,${btoa(binary)}`;
  }
  return { entry, imports };
}

/** Export data plus the common page and renderer, never a clone of live content. */
export async function buildHtml({ title, doc, documentId, view }) {
  // Capture the data synchronously so updates during resource loading cannot alter it.
  const payload = JSON.parse(JSON.stringify({ doc, documentId, title, view }));
  const requests = new Map();
  async function resource(url, binary = false) {
    const absolute = new URL(url, location.href).href;
    const key = `${binary}:${absolute}`;
    if (!requests.has(key))
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

  const output = new DOMParser().parseFromString(
    await resource("/"),
    "text/html",
  );
  output.title = title;
  output.documentElement.dataset.mode = "static";
  const data = output.getElementById("document-data");
  if (!data) throw new Error("Shared page is missing #document-data");

  // Image symbols remain document data; only their resource references are embedded.
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
  for (const page of payload.doc.pages)
    for (const block of page.blocks)
      if (block.type === "chart") await inlineChartImages(block.spec);

  // Preserve image resources as an optional lookup beside the unchanged doc schema.
  const imageSources = new Set();
  const addImage = (source) => {
    try {
      if (
        ["http:", "https:", "data:"].includes(
          new URL(source, location.href).protocol,
        )
      )
        imageSources.add(source);
    } catch {
      // Invalid or sanitizer-rejected image references do not become resources.
    }
  };
  const parser = new window.marked.Marked();
  for (const page of payload.doc.pages) {
    for (const block of page.blocks) {
      if (block.type !== "text") continue;
      parser.walkTokens(parser.lexer(block.spec.md), (token) => {
        if (token.type === "image") {
          // Marked's href still contains entities; a rendered src decodes once.
          const decoder = output.createElement("textarea");
          decoder.innerHTML = token.href;
          addImage(decoder.value);
        }
        if (token.type === "html") {
          const template = output.createElement("template");
          template.innerHTML = token.text;
          for (const image of template.content.querySelectorAll("img")) {
            const source = image.getAttribute("src");
            if (source) addImage(source);
          }
        }
      });
    }
  }
  if (imageSources.size) {
    payload.resources = Object.fromEntries(
      await Promise.all(
        Array.from(imageSources, async (source) => [
          source,
          await embed(source),
        ]),
      ),
    );
  }
  data.textContent = JSON.stringify(payload).replace(/</g, "\\u003c");
  for (const link of output.querySelectorAll('link[rel="stylesheet"]')) {
    const url = new URL(link.getAttribute("href"), location.href).href;
    const style = output.createElement("style");
    style.media = link.media;
    style.textContent = (await inlineCss(await resource(url), url)).replace(
      /</g,
      "\\3c ",
    );
    link.replaceWith(style);
  }
  for (const link of output.querySelectorAll('link[rel="icon"]'))
    link.setAttribute("href", await embed(link.getAttribute("href")));

  const moduleScripts = [
    ...output.querySelectorAll('script[type="module"][src]'),
  ];
  const importMap = {};
  for (const script of moduleScripts) {
    const url = new URL(script.getAttribute("src"), location.href).href;
    const bundled = await bundleModules(url, resource);
    Object.assign(importMap, bundled.imports);
    script.removeAttribute("src");
    script.textContent = `import ${JSON.stringify(bundled.entry)};`;
  }
  if (moduleScripts.length) {
    const map = output.createElement("script");
    map.type = "importmap";
    map.textContent = JSON.stringify({ imports: importMap }).replace(
      /</g,
      "\\u003c",
    );
    moduleScripts[0].before(map);
  }
  for (const script of output.querySelectorAll("script[src]")) {
    script.textContent = (await resource(script.getAttribute("src"))).replace(
      /<\/script/gi,
      "<\\/script",
    );
    script.removeAttribute("src");
    script.removeAttribute("defer");
  }
  return `<!doctype html>\n${output.documentElement.outerHTML}`;
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
