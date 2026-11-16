---
name: canvas-note
description: Create and revise Canvas Note browser documents containing text, charts, tables, math, and code, and respond to document feedback.
disable-model-invocation: true
---

# Canvas Note

Present the main result of the user's request in a Canvas Note document. If no request is provided, ask what the user wants to create or change.

## Discover tool contracts

- Use the Canvas Note tools available in the current environment.
- If the tools are not listed directly, discover them through Codemode's `searchTools("pi-canvas-note")`, then use `describeNamespace("pi-canvas-note")` and `describeTool()` to retrieve the guidance and parameter declarations needed for this operation.
- If the environment provides `tool_search`, you can also use it to discover and load Canvas Note tools.
- Follow the actual tool schemas when constructing arguments. If the tools are unavailable, explain that the Canvas Note extension must be enabled.

## Create documents

1. Organize pages by topic; keep simple content on one page. Split content into blocks that can be revised or receive feedback independently.
2. Use `insert_page` for a new topic and `insert_blocks` to insert related content in a batch. Pass `pageId` explicitly when working across pages.
3. Use text for explanations and conclusions, tables for precise data, charts for trends and comparisons, math for mathematical expressions, and code blocks for source code. Chart options must be pure JSON.
4. Use the returned `pageId`, `blockIds`, `documentPath`, `version`, and URL. Give the user the returned browser URL and a brief summary of what was completed.

## Content examples

These are individual blocks for `insert_blocks`. Always follow the actual tool schema when making a call.

### Text and math

Text blocks support Markdown headings, lists, bold text, links, and math. Use `$...$` for inline math, including expressions adjacent to Chinese text. Use `$$...$$` for display math, with opening and closing delimiters on separate lines. Escape a literal dollar sign as `\$`.

```js
{
  type: "text",
  spec: {
    md: String.raw`## Energy and sums
The energy is $E=mc^2$, where $m$ is mass.

$$
\sum_{i=1}^{n} i = \frac{n(n+1)}{2}
$$

The price is \$5.`
  }
}
```

For a standalone math block, put LaTeX directly in `latex`, without dollar delimiters. In JavaScript, use `String.raw` to preserve backslashes. In JSON, encode each backslash as `\\`.

```js
{ type: "math", align: "center", spec: { latex: String.raw`\frac{a}{b}` } }
```

### Tables

Headers and cells support Markdown and inline math. Keep numeric data as numbers.

```js
{
  type: "table",
  spec: {
    columns: ["**Symbol**", "Meaning", "Value"],
    rows: [["$A_t$", "Value at time t", 42]]
  }
}
```

### Charts

Use a pure-JSON ECharts option. Rely on the default theme colors and add titles, units, and legends as needed.

```js
{
  type: "chart",
  title: "Monthly sales",
  spec: {
    xAxis: { type: "category", data: ["January", "February"] },
    yAxis: { type: "value", name: "Units" },
    series: [{ type: "bar", data: [120, 180] }]
  }
}
```

### Code

Code blocks display source without executing it. Specify a language to enable highlighting; omit it for plain text.

```js
{
  type: "code",
  title: "Calculation example",
  spec: { code: "const answer = 42;", language: "javascript" }
}
```

## Revise documents

1. Update existing pages and blocks rather than inserting duplicates. If current content or IDs are missing, read the returned `documentPath`.
2. Use `update_page` to rename or delete a page and `update_blocks` to revise or delete blocks.
3. `spec` is replaced entirely: provide its complete revised content. When changing a block's type, also provide the complete matching `spec`. Other omitted fields remain unchanged.
4. Each batch succeeds or fails as a whole. If a tool reports that content was saved but the server failed to start, inspect the returned IDs and document path before retrying to avoid duplicate inserts.

## Handle browser feedback

- Decide whether the user is asking a question or requesting changes. Answer questions directly; update the original content when changes are requested.
- `snapshotPath` stores the selected content as it was when feedback was submitted. Read it when you need to understand the referenced content.
- `pageIds` and `blockIds` identify page-level and block-level selections respectively. Preserve both feedback scopes.
- Before editing, read the current `documentPath` and compare it with the snapshot to locate the original content without overwriting subsequent changes with an older version.

## Presentation and server

- Inserting or updating blocks starts the server; creating an empty page does not. After a restart, use the new URL returned by the tools.
- Users can select pages or blocks in the browser to submit feedback and use Export to save a PDF or offline HTML document.
- To open an existing document without editing, the user can run `/canvas-note-server` to start or reuse its server. The URL appears in Pi's status bar.
