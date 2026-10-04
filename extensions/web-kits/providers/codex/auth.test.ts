import assert from "node:assert/strict";
import { test } from "node:test";
import { WebSearchError } from "../../core/errors.ts";
import {
  buildCodexHeaders,
  type CodexModelRegistry,
  extractCodexAccountId,
  resolveCodexAuth,
} from "./auth.ts";

export function makeToken(accountId = "fixture-account-123"): string {
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return [
    encode({ alg: "none" }),
    encode({
      "https://api.openai.com/auth": { chatgpt_account_id: accountId },
    }),
    "signature",
  ].join(".");
}

const accessToken = makeToken();

function registry(token = accessToken, source = "OAuth"): CodexModelRegistry {
  return {
    getProviderAuth: async (provider) => {
      assert.equal(provider, "openai-codex");
      return {
        auth: {
          apiKey: token,
          headers: { "extra-secret": "fixture-extra" },
          baseUrl: "https://not-the-endpoint.example",
        },
        source,
      };
    },
  };
}

test("OAuth resolution needs no discovered model and ignores foreign headers/URLs", async () => {
  const auth = await resolveCodexAuth(registry());
  assert.deepEqual(auth, { accessToken, accountId: "fixture-account-123" });
  const headers = buildCodexHeaders(auth);
  assert.deepEqual([...headers.keys()].sort(), [
    "accept",
    "authorization",
    "chatgpt-account-id",
    "content-type",
    "originator",
  ]);
  assert.equal(headers.get("authorization"), `Bearer ${accessToken}`);
  assert.equal(headers.get("chatgpt-account-id"), "fixture-account-123");
});

test("non-OAuth, missing, malformed and unsafe credentials fail without raw diagnostics", async () => {
  const cases: Array<CodexModelRegistry | undefined> = [
    undefined,
    registry(accessToken, "stored API key"),
    registry("fixture-not-a-jwt"),
    registry(makeToken("bad\r\nheader")),
    registry(`${accessToken}\n`),
    { getProviderAuth: async () => undefined },
    { getProviderAuth: async () => ({ auth: {}, source: "OAuth" }) },
    {
      getProviderAuth: async () => {
        throw new Error(`fixture-error ${accessToken}`);
      },
    },
  ];
  for (const candidate of cases) {
    await assert.rejects(resolveCodexAuth(candidate), (error: unknown) => {
      assert.ok(error instanceof WebSearchError);
      assert.equal(error.code, "auth");
      assert.doesNotMatch(
        `${error.stack} ${JSON.stringify(error)}`,
        /fixture-|eyJ|bad/,
      );
      return true;
    });
  }
});

test("JWT parsing and header validation reject malformed claims", () => {
  for (const token of [
    "no.jwt",
    "x.e30.z",
    "x.bm90LWpzb24.z",
    makeToken(""),
    makeToken("é"),
    makeToken("a".repeat(257)),
  ])
    assert.equal(extractCodexAccountId(token), undefined);
  for (const value of [
    "",
    "bad\tvalue",
    "bad\r\nvalue",
    "é",
    "a".repeat(8_193),
  ]) {
    assert.throws(
      () =>
        buildCodexHeaders({ accessToken: value, accountId: "fixture-account" }),
      WebSearchError,
    );
  }
});
