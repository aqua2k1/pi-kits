import assert from "node:assert/strict";
import * as contracts from "../../core/contracts.js";

export const clientGlobals = { CanvasNoteContracts: contracts };

// vm.Script cannot link ESM. Bind the single static import to the actual shared
// module, leaving the client helpers and startup/runtime code unchanged.
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
  return source.replace(imported, "const {$1} = CanvasNoteContracts;\n");
}
