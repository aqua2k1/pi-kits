import assert from "node:assert/strict";
import { test } from "node:test";
import { WebFetchError } from "./errors.ts";
import { resolveGitHubRef } from "./github-refs.ts";
import { parseGitHubUrl } from "./github-url.ts";

function info(tail = "feature/topic/src/file.ts", type = "blob") {
  const parsed = parseGitHubUrl(
    `https://github.com/acme/project/${type}/${tail}`,
  );
  assert.ok(parsed);
  return parsed;
}

function api(heads: string[], tags: string[] = []) {
  return {
    async apiJson(endpoint: string) {
      const namespace = endpoint.includes("/heads/") ? "heads" : "tags";
      return {
        value: (namespace === "heads" ? heads : tags).map((name) => ({
          ref: `refs/${namespace}/${name}`,
        })),
      };
    },
  };
}

test("refs resolution uses real slash branches and tags, not the first segment", async () => {
  for (const gh of [api(["feature/topic"]), api([], ["feature/topic"])]) {
    const resolved = await resolveGitHubRef(info(), gh);
    assert.equal(resolved?.ref, "feature/topic");
    assert.equal(resolved?.path, "src/file.ts");
    assert.equal(resolved?.unresolvedSegments, undefined);
  }
  const tree = await resolveGitHubRef(
    info("feature/topic", "tree"),
    api(["feature/topic"]),
  );
  assert.equal(tree?.ref, "feature/topic");
  assert.equal(tree?.path, "");
});

test("ambiguous, absent, incomplete or unavailable refs safely decline", async () => {
  assert.equal(
    await resolveGitHubRef(info(), api(["feature", "feature/topic"])),
    null,
  );
  assert.equal(await resolveGitHubRef(info(), api(["feature/other"])), null);
  assert.equal(
    await resolveGitHubRef(info(), {
      async apiJson() {
        return null;
      },
    }),
    null,
  );
  assert.equal(
    await resolveGitHubRef(info(), {
      async apiJson() {
        return { value: {} };
      },
    }),
    null,
  );
  assert.equal(
    await resolveGitHubRef(info(), {
      async apiJson() {
        throw new WebFetchError("timeout", "timeout");
      },
    }),
    null,
  );
  // The same branch/tag name is one boundary, not two.
  assert.equal(
    (await resolveGitHubRef(info(), api(["feature/topic"], ["feature/topic"])))
      ?.ref,
    "feature/topic",
  );
});

test("encoded slash and full SHA bypass discovery, cancellation is preserved", async () => {
  const gh = {
    async apiJson(): Promise<never> {
      throw new Error("must not query");
    },
  };
  const encoded = info("feature%2Ftopic/src/file.ts");
  assert.equal(await resolveGitHubRef(encoded, gh), encoded);
  const sha = info(`${"a".repeat(40)}/src/file.ts`);
  assert.equal(await resolveGitHubRef(sha, gh), sha);
  await assert.rejects(
    resolveGitHubRef(info(), {
      async apiJson() {
        throw new WebFetchError("cancelled", "cancelled");
      },
    }),
    { code: "cancelled" },
  );
});
