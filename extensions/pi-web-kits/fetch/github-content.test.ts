import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { generateCloneContent, resolveWithinRepo } from "./github-content.ts";
import type { GitHubUrlInfo } from "./github-url.ts";

const info = (overrides: Partial<GitHubUrlInfo>): GitHubUrlInfo => ({
  owner: "acme",
  repo: "project",
  path: "",
  ref: "main",
  refIsFullSha: false,
  type: "root",
  ...overrides,
});

test("generateCloneContent renders repository structure and blob content", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-tools-repo-"));
  try {
    await mkdir(join(root, "src"));
    await writeFile(join(root, "README.md"), "# Example\n");
    await writeFile(join(root, "src", "index.ts"), "export const value = 1;\n");
    await writeFile(join(root, ".gitignore"), "node_modules\n");

    const rootContent = await generateCloneContent(root, info({}));
    assert.match(rootContent.text, /Repository cloned to:/);
    assert.match(rootContent.text, /README\.md/);
    assert.match(rootContent.text, /src\//);

    const blobContent = await generateCloneContent(
      root,
      info({ type: "blob", path: "src/index.ts" }),
    );
    assert.match(blobContent.text, /export const value = 1/);
    assert.equal(blobContent.repositoryPath, root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("generateCloneContent renders directories and binary files without reading them as text", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-tools-repo-"));
  try {
    await mkdir(join(root, "assets"));
    await writeFile(join(root, "assets", "image.png"), Buffer.from([0, 1, 2]));
    const directory = await generateCloneContent(
      root,
      info({ type: "tree", path: "assets" }),
    );
    assert.match(directory.text, /image\.png/);

    const binary = await generateCloneContent(
      root,
      info({ type: "blob", path: "assets/image.png" }),
    );
    assert.match(binary.text, /Binary file/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resolveWithinRepo rejects traversal and symlink escapes", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-tools-repo-"));
  const outside = await mkdtemp(join(tmpdir(), "pi-web-tools-outside-"));
  try {
    await writeFile(join(outside, "secret.txt"), "secret");
    await symlink(outside, join(root, "link"));
    assert.equal(await resolveWithinRepo(root, "../secret.txt"), null);
    assert.equal(await resolveWithinRepo(root, "link/secret.txt"), null);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
