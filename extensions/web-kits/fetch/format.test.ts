import assert from "node:assert/strict";
import { test } from "node:test";
import { Value } from "typebox/value";
import { FetchDetailsSchema, FetchOutputSchema } from "../schema.ts";
import {
  MAX_FETCH_OUTPUT_BYTES,
  MAX_FETCH_PREVIEW_BYTES,
} from "../shared/limits.ts";
import { WebFetchError } from "./errors.ts";
import { buildFetchOutput as buildOutput } from "./format.ts";
import type { FetchResponse } from "./types.ts";

function buildFetchOutput(...args: Parameters<typeof buildOutput>) {
  const output = buildOutput(...args);
  assert.ok(Value.Check(FetchOutputSchema, output.structuredContent));
  assert.ok(Value.Check(FetchDetailsSchema, output.details));
  const { text, isPreview, ...metadata } = output.structuredContent;
  assert.equal(typeof text, "string");
  assert.equal(typeof isPreview, "boolean");
  assert.deepEqual(metadata, output.details);
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

test("buildFetchOutput returns small content inline and includes its path", () => {
  const output = buildFetchOutput(response("hello\nworld"));
  assert.match(output.content[0]?.text ?? "", /hello\nworld/);
  assert.match(output.content[0]?.text ?? "", /content\.txt/);
  assert.equal(
    output.details.fullOutputPath,
    "/tmp/pi-web-fetch-example/content.txt",
  );
  assert.equal(output.details.truncation, undefined);
  assert.equal(output.structuredContent.text, "hello\nworld");
  assert.equal(output.structuredContent.isPreview, false);
});

test("buildFetchOutput copies truncation details", () => {
  const input = {
    ...response("hello"),
    truncation: { totalBytes: 100, outputBytes: 5 },
  };
  const output = buildFetchOutput(input);
  input.truncation.totalBytes = 200;
  assert.equal(output.details.truncation?.totalBytes, 100);
  assert.equal(output.structuredContent.text, "hello");
  assert.equal(output.structuredContent.isPreview, true);
});

test("buildFetchOutput returns a bounded preview for large content", () => {
  const text = "x".repeat(MAX_FETCH_PREVIEW_BYTES + 100);
  const output = buildFetchOutput(response(text));
  const rendered = output.content[0]?.text ?? "";
  assert.equal(
    output.structuredContent.text,
    text.slice(0, MAX_FETCH_PREVIEW_BYTES),
  );
  assert.equal(output.structuredContent.isPreview, true);
  assert.match(rendered, /Preview/);
  assert.match(rendered, /Use the `read` tool/);
  assert.ok(Buffer.byteLength(rendered) < 50 * 1_024);
  assert.equal(
    output.details.fullOutputPath,
    "/tmp/pi-web-fetch-example/content.txt",
  );
});

for (const source of ["native-http", "github-gh", "github-clone"] as const) {
  test(`machine fetch output preserves optional metadata and URL aliases for ${source}`, () => {
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
      fullOutputPath: input.fullOutputPath,
      expiresAt: input.expiresAt,
      truncation: input.truncation,
      ...(input.repositoryPath ? { repositoryPath: input.repositoryPath } : {}),
    });
    assert.ok(!JSON.stringify(output).includes("password"));
    assert.ok(!JSON.stringify(output).includes("hidden"));
    assert.match(output.content[0].text, /Content limited to 5 of 100 bytes/);
    if (input.repositoryPath)
      assert.ok(output.content[0].text.includes(input.repositoryPath));
  });
}

test("empty fetch output omits absent optional metadata and preserves exact text", () => {
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
    fullOutputPath: "/tmp/content.txt",
  });
  assert.equal(
    output.content[0].text,
    "**Fetched:** https://example.com/\n**Source:** native-http\n**Full content:** /tmp/content.txt\n\n",
  );
});

test("JSON escaping and both text copies count toward the fetch return budget", () => {
  const text = "\u0001".repeat(MAX_FETCH_PREVIEW_BYTES);
  const input = response(text);
  const output = buildFetchOutput(input);
  assert.equal(output.structuredContent.isPreview, true);
  assert.ok(output.structuredContent.text.length < text.length);
  assert.ok(text.startsWith(output.structuredContent.text));
  assert.ok(output.content[0].text.includes(output.structuredContent.text));
  assert.equal(output.details.contentLength, input.contentLength);
  assert.equal(output.details.truncation, undefined);
});

test("line-limited machine previews keep the saved file path without claiming complete text", () => {
  const output = buildFetchOutput(response("line\n".repeat(3_000)));
  assert.equal(output.structuredContent.isPreview, true);
  assert.ok(output.structuredContent.text.split("\n").length <= 2_000);
  assert.ok(
    Buffer.byteLength(output.structuredContent.text) <= MAX_FETCH_PREVIEW_BYTES,
  );
  assert.equal(
    output.structuredContent.fullOutputPath,
    output.details.fullOutputPath,
  );
});

test("metadata that cannot fit the fetch budget throws instead of changing legacy details", () => {
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
