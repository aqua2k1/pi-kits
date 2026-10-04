import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { useAgentDir } from "../../tests/helpers/agent-dir.ts";
import { resolveWorkerExtensions } from "./extensions.ts";

function packageFixture(root: string, name: string) {
  mkdirSync(join(root, "dist"), { recursive: true });
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({
      name,
      version: "1.0.0",
      pi: { extensions: ["./dist/index.ts"] },
    }),
  );
  const entry = join(root, "dist/index.ts");
  writeFileSync(entry, "export default () => {};");
  return entry;
}

test("Pi resolves builtins, installed npm/git packages and local manifests without source-prefix rules", async (t) => {
  const dir = useAgentDir(t);
  const npm = packageFixture(
    join(dir, "npm/node_modules/@test/browser"),
    "@test/browser",
  );
  const git = packageFixture(
    join(dir, "git/github.com/example/tools"),
    "git-tools",
  );
  const local = packageFixture(join(dir, "local-kit"), "local-kit");
  assert.deepEqual(
    await resolveWorkerExtensions([
      "builtin:codemode",
      "npm:@test/browser",
      "git:github.com/example/tools",
      "local-kit",
      npm,
      " builtin:codemode ",
    ]),
    ["builtin:codemode", npm, git, local],
  );
});

test("logical names are read from package declarations, not kit-specific rules", async (t) => {
  const dir = useAgentDir(t);
  for (const [source, root] of [
    ["local-named", join(dir, "local-named")],
    ["npm:@test/named", join(dir, "npm/node_modules/@test/named")],
    ["git:github.com/example/named", join(dir, "git/github.com/example/named")],
  ]) {
    const entry = packageFixture(root, "named");
    const other = join(root, "dist/other.ts");
    writeFileSync(other, "export default () => {};");
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({
        name: "named",
        version: "1.0.0",
        pi: { extensions: ["./dist/index.ts", "./dist/other.ts"] },
        extensionResources: {
          "arbitrary-resource": "./dist/index.ts",
          group: ["./dist/index.ts", "./dist/other.ts"],
        },
      }),
    );
    assert.deepEqual(
      await resolveWorkerExtensions([
        { source, extensions: ["arbitrary-resource"] },
      ]),
      [entry],
    );
    assert.deepEqual(
      await resolveWorkerExtensions([
        { source, extensions: ["group"] },
        { source, extensions: ["arbitrary-resource"] },
      ]),
      [entry, other],
    );
    assert.deepEqual(
      await resolveWorkerExtensions([{ source, extensions: [] }]),
      [],
    );
    await assert.rejects(
      resolveWorkerExtensions([{ source, extensions: ["unknown"] }]),
      /Unknown extension resource/,
    );
  }
});

test("named selections cannot load undeclared, absolute or escaping entrypoints", async (t) => {
  const dir = useAgentDir(t);
  const root = join(dir, "restricted");
  packageFixture(root, "restricted");
  for (const path of [
    "./secret.ts",
    "../outside.ts",
    "/outside.ts",
    true,
    [],
    ["./dist/index.ts", "./secret.ts"],
  ]) {
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({
        pi: { extensions: ["./dist/index.ts"] },
        extensionResources: { selected: path },
      }),
    );
    await assert.rejects(
      resolveWorkerExtensions([
        { source: "restricted", extensions: ["selected"] },
      ]),
      /Invalid extension resource|outside the enabled Pi manifest/,
    );
  }
});

test("named selections require declarations and never guess names from paths", async (t) => {
  const dir = useAgentDir(t);
  packageFixture(join(dir, "no-names"), "no-names");
  await assert.rejects(
    resolveWorkerExtensions([
      { source: "no-names", extensions: ["dist/index.ts"] },
    ]),
    /no extensionResources/,
  );
  await assert.rejects(
    resolveWorkerExtensions([
      { source: "builtin:codemode", extensions: ["anything"] },
    ]),
    /require a package/,
  );
});

test("empty list loads nothing and missing local sources fail instead of silently disappearing", async (t) => {
  useAgentDir(t);
  assert.deepEqual(await resolveWorkerExtensions([]), []);
  await assert.rejects(
    resolveWorkerExtensions(["missing.ts"]),
    /no enabled extensions/,
  );
});

test("an empty package manifest does not expose undeclared extension files", async (t) => {
  const dir = useAgentDir(t);
  const root = join(dir, "empty-kit");
  packageFixture(root, "empty-kit");
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ pi: { extensions: [] } }),
  );
  await assert.rejects(
    resolveWorkerExtensions(["empty-kit"]),
    /no enabled extensions/,
  );
});
