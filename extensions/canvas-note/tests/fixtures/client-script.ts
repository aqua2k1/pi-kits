import assert from "node:assert/strict";
import * as contracts from "../../core/contracts.js";
import * as chartTheme from "../../web/chart-theme.js";
import * as htmlExport from "../../web/export-html.js";
import * as outlineModel from "../../web/outline-model.js";
import * as outlineView from "../../web/outline-view.js";

export const clientGlobals = {
  CanvasNoteContracts: contracts,
  CanvasNoteChartTheme: chartTheme,
  CanvasNoteHtmlExport: htmlExport,
  CanvasNoteOutlineModel: outlineModel,
  CanvasNoteOutlineView: outlineView,
};

// vm.Script cannot link ESM. Bind static imports to the actual modules,
// leaving the client helpers and startup/runtime code unchanged.
export function clientScript(source: string): string {
  const imported =
    /^import\s*\{([^}]+)\}\s*from\s*"\.\.\/core\/contracts\.js";\r?\n/;
  const match = imported.exec(source);
  assert.ok(match, "Client must load the shared contract module");
  for (const name of match[1]
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean)) {
    assert.ok(Object.hasOwn(contracts, name), `Unknown shared import: ${name}`);
  }
  const themeImport =
    /^import\s*\{([^}]+)\}\s*from\s*"\.\/chart-theme\.js";\r?\n/m;
  const themeMatch = themeImport.exec(source);
  assert.ok(themeMatch, "Client must load the chart theme module");
  for (const name of themeMatch[1]
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean))
    assert.ok(
      Object.hasOwn(chartTheme, name),
      `Unknown chart theme import: ${name}`,
    );
  return source
    .replace(imported, "const {$1} = CanvasNoteContracts;\n")
    .replace(themeImport, "const {$1} = CanvasNoteChartTheme;\n")
    .replace(
      /^import\s*\{([^}]+)\}\s*from\s*"\.\/export-html\.js";\r?\n/m,
      "const {$1} = CanvasNoteHtmlExport;\n",
    )
    .replace(
      /^import\s*\{([^}]+)\}\s*from\s*"\.\/outline-model\.js";\r?\n/m,
      "const {$1} = CanvasNoteOutlineModel;\n",
    )
    .replace(
      /^import\s*\{([^}]+)\}\s*from\s*"\.\/outline-view\.js";\r?\n/m,
      "const {$1} = CanvasNoteOutlineView;\n",
    );
}
