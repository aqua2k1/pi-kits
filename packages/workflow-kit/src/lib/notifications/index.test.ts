import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { test } from "node:test";
import { SCRIPT_PATHS } from "./core.ts";

const packageRoot = new URL("../../../", import.meta.url);

test("manifest exposes only the three extension factories and the pure API", () => {
  const manifest = JSON.parse(
    readFileSync(new URL("package.json", packageRoot), "utf8"),
  );
  assert.equal(manifest.name, "pi-workflow-kit");
  assert.deepEqual(manifest.pi.extensions, [
    "./src/extensions/commit/index.ts",
    "./src/extensions/notify/index.ts",
    "./src/extensions/ask-user-question/index.ts",
  ]);
  assert.equal(
    manifest.exports["./notifications"],
    "./src/lib/notifications/index.ts",
  );
  for (const entry of manifest.pi.extensions) {
    assert.ok(statSync(new URL(entry, packageRoot)).isFile());
  }
});

test("Unix notification adapters retain executable permissions", () => {
  if (process.platform === "win32") return;
  for (const script of [SCRIPT_PATHS.linux, SCRIPT_PATHS.macos]) {
    assert.notEqual(statSync(script).mode & 0o111, 0, script);
  }
});

test("pure notification API loads without Pi, extension registration, timers or process launches", () => {
  // Fresh process: no cached module can hide an accidental dependency on an
  // extension entry. A loader rejects both host packages and extension modules.
  const loader = `
export async function resolve(specifier, context, nextResolve) {
  if (specifier === "@pi-kits/config") {
    throw new Error("Pure API imported configuration");
  }
  if (specifier.startsWith("@earendil-works/pi-")) {
    throw new Error("Pure API imported a Pi host package: " + specifier);
  }
  const result = await nextResolve(specifier, context);
  if (result.url.includes("/src/extensions/")) {
    throw new Error("Pure API imported an extension: " + result.url);
  }
  return result;
}
`;
  const script = `
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import timers from "node:timers";
import { register, syncBuiltinESMExports } from "node:module";
register(${JSON.stringify(`data:text/javascript,${encodeURIComponent(loader)}`)});
let launches = 0;
childProcess.execFile = (_file, _args, _options, callback) => {
  launches += 1;
  callback(null);
};
childProcess.spawn = () => { throw new Error("Unexpected process launch"); };
const rejectTimer = () => { throw new Error("Unexpected notification timer"); };
timers.setTimeout = globalThis.setTimeout = rejectTimer;
timers.setInterval = globalThis.setInterval = rejectTimer;
syncBuiltinESMExports();
const api = await import(${JSON.stringify(new URL("index.ts", import.meta.url).href)});
assert.deepEqual(Object.keys(api), ["notify"]);
assert.equal(launches, 0, "Import must not deliver a notification");
assert.equal(typeof api.notify("Build", "Finished"), "boolean");
assert.equal(launches, 1, "Only an explicit API call may launch the adapter");
`;
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", script],
    { cwd: packageRoot, encoding: "utf8", timeout: 15_000 },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
