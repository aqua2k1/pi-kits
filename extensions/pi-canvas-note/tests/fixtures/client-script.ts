import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as contracts from "../../core/contracts.js";
import * as chartTheme from "../../web/chart-theme.js";
import * as htmlExport from "../../web/export-html.js";
import * as exportScope from "../../web/export-scope.js";
import * as outlineModel from "../../web/outline-model.js";
import * as outlineView from "../../web/outline-view.js";
import * as selectionManager from "../../web/selection-manager.js";

export const clientGlobals = {
  CanvasNoteContracts: contracts,
  CanvasNoteChartTheme: chartTheme,
  CanvasNoteHtmlExport: htmlExport,
  CanvasNoteExportScope: exportScope,
  CanvasNoteSelectionManager: selectionManager,
  CanvasNoteOutlineModel: outlineModel,
  CanvasNoteOutlineView: outlineView,
};

const modules: Record<string, keyof typeof clientGlobals> = {
  "../core/contracts.js": "CanvasNoteContracts",
  "./chart-theme.js": "CanvasNoteChartTheme",
  "./export-html.js": "CanvasNoteHtmlExport",
  "./export-scope.js": "CanvasNoteExportScope",
  "./selection-manager.js": "CanvasNoteSelectionManager",
  "./outline-model.js": "CanvasNoteOutlineModel",
  "./outline-view.js": "CanvasNoteOutlineView",
};

function bindImports(source: string): string {
  return source.replace(
    /^import\s*\{([^}]+)\}\s*from\s*"([^"]+)";\r?\n/gm,
    (_, names: string, path: string) => {
      const global = modules[path];
      assert.ok(global, `Unknown client import: ${path}`);
      for (const name of names
        .split(",")
        .map((name) => name.trim())
        .filter(Boolean))
        assert.ok(
          Object.hasOwn(clientGlobals[global], name),
          `Unknown import: ${name}`,
        );
      return `const {${names}} = ${global};\n`;
    },
  );
}

// vm.Script cannot link ESM. Evaluate each actual module in its own scope,
// binding leaf imports to the real modules; keep startup and runtime unchanged.
export function clientScript(source: string): string {
  if (source.includes('from "./document-view.js"')) {
    const bundled = [
      ["document-view.js", "createDocumentView"],
      ["online-controller.js", "startOnlineController"],
    ].map(([file, entry]) => {
      const module = readFileSync(
        new URL(`../../web/${file}`, import.meta.url),
        "utf8",
      );
      return `const ${entry} = (() => {\n${bindImports(module).replace(/^export /gm, "")}\nreturn ${entry};\n})();\n`;
    });
    return bundled.join("") + source.replace(/^import[^\n]+\n/gm, "");
  }
  // Helper-only tests evaluate definitions without creating a view or browser.
  return bindImports(source).replace(
    /export function createDocumentView\([\s\S]*?\) \{/,
    "{",
  );
}
