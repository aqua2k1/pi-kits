import assert from "node:assert/strict";
import { test } from "node:test";
import { Value } from "typebox/value";
import { FetchDetailsSchema, FetchOutputSchema } from "../schema.ts";
import { MAX_FETCH_OUTPUT_BYTES } from "../shared/limits.ts";
import { WebFetchError } from "./errors.ts";
import { buildFetchOutput as buildOutput } from "./format.ts";
import type { FetchResponse } from "./types.ts";

function buildFetchOutput(...args: Parameters<typeof buildOutput>) {
  const output = buildOutput(...args);
  assert.ok(Value.Check(FetchOutputSchema, output.structuredContent));
  assert.ok(Value.Check(FetchDetailsSchema, output.details));
  assert.deepEqual(output.structuredContent, output.details);
  for (const field of [
    "text",
    "isPreview",
    "fullOutputPath",
    "expiresAt",
    "truncation",
  ]) {
    assert.equal(field in output.structuredContent, false, field);
  }
  assert.ok(
    Buffer.byteLength(JSON.stringify(output)) <= MAX_FETCH_OUTPUT_BYTES,
  );
  return output;
}

function response(text: string): FetchResponse {
  return {
    text,
    title: "Example",
    contentType: "text/plain",
    contentLength: Buffer.byteLength(text),
    finalUrl: "https://example.com/page",
    source: "native-http",
    fullOutputPath: "/tmp/pi-web-fetch-example/content.txt",
  };
}

test("small fetch output contains metadata and read guidance, never inline content", () => {
  const output = buildFetchOutput(response("hello\nworld"));
  assert.ok(!JSON.stringify(output).includes("hello"));
  assert.match(output.content[0].text, /content\.txt/);
  assert.match(output.content[0].text, /Use the `read` tool/);
  assert.deepEqual(output.structuredContent.savedContent, {
    path: "/tmp/pi-web-fetch-example/content.txt",
    bytes: 11,
    truncated: false,
  });
});

test("fetch output copies saved truncation details without claiming a complete source", () => {
  const input = {
    ...response("hello"),
    truncation: { totalBytes: 100, outputBytes: 5 },
  };
  const output = buildFetchOutput(input);
  input.truncation.totalBytes = 200;
  assert.deepEqual(output.details.savedContent, {
    path: input.fullOutputPath,
    bytes: 5,
    truncated: true,
    truncation: { totalBytes: 100, outputBytes: 5 },
  });
  assert.match(
    output.content[0].text,
    /Saved content limited to 5 of 100 bytes/,
  );
});

test("saved bytes measure UTF-8 text, not the HTTP response length", () => {
  const output = buildFetchOutput({
    ...response("中文🙂"),
    contentLength: 999,
  });
  assert.equal(output.structuredContent.savedContent.bytes, 10);
  assert.equal(output.structuredContent.contentLength, 999);
});

test("large, line-heavy, and JSON-escaped content never appear in tool output", () => {
  for (const text of [
    "large-body-marker".repeat(10_000),
    "line-body-marker\n".repeat(3_000),
    "\u0001".repeat(8 * 1_024),
  ]) {
    const output = buildFetchOutput(response(text));
    assert.equal(
      output.structuredContent.savedContent.bytes,
      Buffer.byteLength(text),
    );
    assert.equal(output.structuredContent.savedContent.truncated, false);
    assert.ok(!JSON.stringify(output).includes(text.slice(0, 100)));
    assert.ok(Buffer.byteLength(JSON.stringify(output)) < 2_000);
    assert.doesNotMatch(output.content[0].text, /Preview/);
  }
});

for (const source of ["native-http", "github-gh", "github-clone"] as const) {
  test(`fetch output preserves saved metadata and redacts URL aliases for ${source}`, () => {
    const input: FetchResponse = {
      ...response("hello"),
      finalUrl: "https://user:password@example.com/final?token=hidden#fragment",
      source,
      expiresAt: "2026-01-02T03:04:05.000Z",
      truncation: {
        totalBytes: 100,
        outputBytes: 5,
        totalLines: 10,
        outputLines: 1,
      },
      ...(source === "github-clone"
        ? { repositoryPath: "/tmp/pi-web-tools-github/hash" }
        : {}),
    };
    const output = buildFetchOutput(input);
    assert.deepEqual(output.details, {
      url: "https://example.com/final?token=%5Bredacted%5D",
      finalUrl: "https://example.com/final?token=%5Bredacted%5D",
      title: "Example",
      contentType: "text/plain",
      contentLength: 5,
      source,
      savedContent: {
        path: input.fullOutputPath,
        bytes: 5,
        truncated: true,
        expiresAt: input.expiresAt,
        truncation: input.truncation,
      },
      ...(input.repositoryPath ? { repositoryPath: input.repositoryPath } : {}),
    });
    assert.ok(!JSON.stringify(output).includes("password"));
    assert.ok(!JSON.stringify(output).includes("hidden"));
    if (input.repositoryPath)
      assert.ok(output.content[0].text.includes(input.repositoryPath));
  });
}

test("empty saved content has zero bytes and omits absent optional metadata", () => {
  const output = buildFetchOutput({
    text: "",
    finalUrl: "https://example.com/",
    source: "native-http",
    fullOutputPath: "/tmp/content.txt",
  });
  assert.deepEqual(output.details, {
    url: "https://example.com/",
    finalUrl: "https://example.com/",
    source: "native-http",
    savedContent: { path: "/tmp/content.txt", bytes: 0, truncated: false },
  });
  assert.match(output.content[0].text, /Saved bytes:\*\* 0/);
  assert.match(output.content[0].text, /Content is not returned inline/);
});

test("schema requires a saved file and explicit byte count and truncation state", () => {
  const metadata = buildFetchOutput(response("hello")).structuredContent;
  for (const field of ["path", "bytes", "truncated"]) {
    const savedContent: Record<string, unknown> = { ...metadata.savedContent };
    delete savedContent[field];
    assert.equal(
      Value.Check(FetchOutputSchema, { ...metadata, savedContent }),
      false,
    );
  }
  assert.equal(
    Value.Check(FetchOutputSchema, {
      ...metadata,
      savedContent: { ...metadata.savedContent, bytes: -1 },
    }),
    false,
  );
});

test("metadata that cannot fit the fetch budget throws instead of dropping fields", () => {
  assert.throws(
    () =>
      buildOutput({
        ...response("hello"),
        title: "x".repeat(MAX_FETCH_OUTPUT_BYTES),
      }),
    (error: unknown) =>
      error instanceof WebFetchError && error.code === "invalid-response",
  );
});
