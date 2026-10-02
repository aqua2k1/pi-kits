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
      ref: "main",
      path: "src/index.ts",
      refIsFullSha: false,
      type: "blob",
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

test("encodeGitHubPath encodes each path component", () => {
  assert.equal(encodeGitHubPath("src/a file.ts"), "src/a%20file.ts");
  assert.equal(encodeGitHubPath("a/b?c"), "a/b%3Fc");
});
