import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_FETCH_PREVIEW_BYTES } from "../shared/limits.ts";
import { buildFetchOutput } from "./format.ts";
import type { FetchResponse } from "./types.ts";

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
});

test("buildFetchOutput copies truncation details", () => {
  const input = {
    ...response("hello"),
    truncation: { totalBytes: 100, outputBytes: 5 },
  };
  const output = buildFetchOutput(input);
  input.truncation.totalBytes = 200;
  assert.equal(output.details.truncation?.totalBytes, 100);
});

test("buildFetchOutput returns a bounded preview for large content", () => {
  const text = "x".repeat(MAX_FETCH_PREVIEW_BYTES + 100);
  const output = buildFetchOutput(response(text));
  const rendered = output.content[0]?.text ?? "";
  assert.match(rendered, /Preview/);
  assert.match(rendered, /Use the `read` tool/);
  assert.ok(Buffer.byteLength(rendered) < 50 * 1_024);
  assert.equal(
    output.details.fullOutputPath,
    "/tmp/pi-web-fetch-example/content.txt",
  );
});
