import assert from "node:assert/strict";
import { rm, stat } from "node:fs/promises";
import { test } from "node:test";
import { MAX_FETCH_CONTENT_BYTES } from "../shared/limits.ts";
import { WebFetchError } from "./errors.ts";
import { fetchDocument, withFetchDeadline } from "./http.ts";

function responseFromChunks(
  chunks: readonly Uint8Array[],
  options: { contentType?: string; status?: number; url?: string } = {},
): Response {
  let index = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[index++];
      if (chunk !== undefined) controller.enqueue(chunk);
      else controller.close();
    },
  });
  const response = new Response(body, {
    status: options.status ?? 200,
    headers: options.contentType
      ? { "content-type": options.contentType }
      : undefined,
  });
  if (options.url)
    Object.defineProperty(response, "url", { value: options.url });
  return response;
}

async function removeResult(path: string): Promise<void> {
  await rm(path.substring(0, path.lastIndexOf("/")), {
    recursive: true,
    force: true,
  });
}

test("withFetchDeadline classifies timeout and parent cancellation", async () => {
  await assert.rejects(
    withFetchDeadline(10, undefined, async () => {
      await new Promise<never>(() => {});
    }),
    (error: unknown) =>
      error instanceof WebFetchError && error.code === "timeout",
  );

  const parent = new AbortController();
  const operation = withFetchDeadline(5_000, parent.signal, async (signal) => {
    await new Promise<never>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      });
    });
  });
  parent.abort();
  await assert.rejects(
    operation,
    (error: unknown) =>
      error instanceof WebFetchError && error.code === "cancelled",
  );
});

test("fetchDocument streams text to a temp file and extracts HTML", async () => {
  const html = "<title>Example</title><p>Hello <b>world</b></p>";
  let init: RequestInit | undefined;
  const result = await fetchDocument(
    { url: new URL("https://example.test/page"), raw: false },
    {
      timeoutMs: 5_000,
      fetch: async (_url, requestInit) => {
        init = requestInit;
        return responseFromChunks(
          [
            new TextEncoder().encode(html.slice(0, 10)),
            new TextEncoder().encode(html.slice(10)),
          ],
          {
            contentType: "text/html; charset=utf-8",
            url: "https://example.test/final",
          },
        );
      },
    },
  );
  try {
    assert.equal(init?.redirect, "follow");
    const headers = new Headers(init?.headers);
    assert.match(
      headers.get("user-agent") ?? "",
      /^Mozilla\/5\.0 \(X11; Linux x86_64\).*Chrome\/152\.0\.0\.0/,
    );
    assert.equal(
      headers.get("accept"),
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
    );
    assert.equal(headers.get("accept-language"), "en-US,en;q=0.9");
    assert.equal(headers.get("authorization"), null);
    assert.equal(result.text, "Example\nHello world");
    assert.equal(result.title, "Example");
    assert.equal(result.finalUrl, "https://example.test/final");
    assert.equal(result.source, "native-http");
    assert.equal(await stat(result.fullOutputPath).then(() => true), true);
  } finally {
    await removeResult(result.fullOutputPath);
  }
});

test("fetchDocument accepts an empty text response", async () => {
  const result = await fetchDocument(
    { url: new URL("https://example.test/empty"), raw: false },
    {
      timeoutMs: 5_000,
      fetch: async () =>
        new Response(null, {
          status: 204,
          headers: { "content-type": "text/plain" },
        }),
    },
  );
  try {
    assert.equal(result.text, "");
    assert.equal(await stat(result.fullOutputPath).then(() => true), true);
  } finally {
    await removeResult(result.fullOutputPath);
  }
});

test("fetchDocument rejects an oversized streamed body and cleans up", async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(MAX_FETCH_CONTENT_BYTES));
      controller.enqueue(new Uint8Array(1));
    },
    cancel() {
      cancelled = true;
    },
  });
  await assert.rejects(
    fetchDocument(
      { url: new URL("https://example.test/large"), raw: false },
      {
        timeoutMs: 5_000,
        fetch: async () =>
          new Response(body, {
            status: 200,
            headers: { "content-type": "text/plain" },
          }),
      },
    ),
    (error: unknown) =>
      error instanceof WebFetchError && error.code === "invalid-response",
  );
  assert.equal(cancelled, true);
});

test("fetchDocument classifies status and binary failures", async () => {
  await assert.rejects(
    fetchDocument(
      { url: new URL("https://example.test/nope"), raw: false },
      {
        timeoutMs: 5_000,
        fetch: async () => new Response("secret", { status: 404 }),
      },
    ),
    (error: unknown) =>
      error instanceof WebFetchError && error.code === "unsupported",
  );
  await assert.rejects(
    fetchDocument(
      { url: new URL("https://example.test/image"), raw: false },
      {
        timeoutMs: 5_000,
        fetch: async () =>
          new Response("binary", { headers: { "content-type": "image/png" } }),
      },
    ),
    (error: unknown) =>
      error instanceof WebFetchError && error.code === "unsupported",
  );
});
