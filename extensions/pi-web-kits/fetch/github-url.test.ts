import assert from "node:assert/strict";
import { test } from "node:test";
import { encodeGitHubPath, parseGitHubUrl } from "./github-url.ts";

test("parseGitHubUrl recognizes root, blob and tree URLs", () => {
  assert.deepEqual(parseGitHubUrl("https://github.com/acme/project"), {
    owner: "acme",
    repo: "project",
    path: "",
    refIsFullSha: false,
    type: "root",
  });
  assert.deepEqual(
    parseGitHubUrl("https://github.com/acme/project/blob/main/src/index.ts"),
    {
      owner: "acme",
      repo: "project",
      path: "",
      refIsFullSha: false,
      type: "blob",
      unresolvedSegments: ["main", "src", "index.ts"],
    },
  );
  assert.equal(
    parseGitHubUrl(
      "https://github.com/acme/project/tree/0123456789abcdef0123456789abcdef01234567/src",
    )?.refIsFullSha,
    true,
  );
});

test("parseGitHubUrl leaves non-code pages and unsafe paths to native HTTP", () => {
  assert.equal(
    parseGitHubUrl("https://github.com/acme/project/issues/1"),
    null,
  );
  assert.equal(parseGitHubUrl("https://github.com/acme/project/pulls"), null);
  assert.equal(
    parseGitHubUrl("https://github.com/acme/project/blob/main/../secret"),
    null,
  );
  assert.equal(
    parseGitHubUrl("https://user:pass@github.com/acme/project"),
    null,
  );
  assert.equal(parseGitHubUrl("http://github.com/acme/project"), null);
});

test("parseGitHubUrl preserves explicit encoded slash refs and flags ambiguous boundaries", () => {
  const encoded = parseGitHubUrl(
    "https://github.com/acme/project/blob/feature%2Ftopic/src/file.ts",
  );
  assert.equal(encoded?.ref, "feature/topic");
  assert.equal(encoded?.path, "src/file.ts");
  assert.equal(encoded?.unresolvedSegments, undefined);
  assert.deepEqual(
    parseGitHubUrl("https://github.com/acme/project/tree/feature/topic")
      ?.unresolvedSegments,
    ["feature", "topic"],
  );
  for (const ref of [
    "feature%2F..",
    "feature%2F%2Ftopic",
    "feature%5Ctopic",
    "%00main",
    "%zz",
  ]) {
    assert.equal(
      parseGitHubUrl(`https://github.com/acme/project/blob/${ref}/file.ts`),
      null,
    );
  }
});

test("encodeGitHubPath encodes each path component", () => {
  assert.equal(encodeGitHubPath("src/a file.ts"), "src/a%20file.ts");
  assert.equal(encodeGitHubPath("a/b?c"), "a/b%3Fc");
});
