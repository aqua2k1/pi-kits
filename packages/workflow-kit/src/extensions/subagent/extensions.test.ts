import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { useAgentDir } from "../../test-utils/agent-dir.ts";
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
