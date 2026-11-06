import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { test } from "node:test";
import { WebSearchError } from "../core/errors.ts";
import { type FetchLike, fetchJson, withSearchDeadline } from "./http.ts";
import { MAX_RESPONSE_BYTES } from "./limits.ts";

const encoder = new TextEncoder();

function bytes(value: string): Uint8Array {
  return encoder.encode(value);
}

function responseFromChunks(
  chunks: readonly Uint8Array[],
  status = 200,
): Response {
  let index = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[index++];
      if (chunk !== undefined) {
        controller.enqueue(chunk);
      } else {
        controller.close();
      }
    },
  });
  return new Response(body, { status });
}

function settleWithin<T>(
  promise: Promise<T>,
  milliseconds = 1_000,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("test operation did not settle")),
      milliseconds,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

test("withSearchDeadline: races a hanging auth or fetch operation", async () => {
  for (const provider of ["codex-alpha-search", "searxng"] as const) {
    let started = false;
    let deadlineSignal: AbortSignal | undefined;
    const operation = withSearchDeadline(
      provider,
      10,
      undefined,
      async (signal) => {
        started = true;
        deadlineSignal = signal;
        await new Promise<never>(() => {});
        return "unreachable";
      },
    );

    await assert.rejects(
      settleWithin(operation),
      (error: unknown) =>
        error instanceof WebSearchError && error.code === "timeout",
    );
    assert.equal(started, true);
    assert.equal(deadlineSignal?.aborted, true);
  }
});

test("withSearchDeadline: pre-cancelled parent signals do not run the operation", async () => {
  const parent = new AbortController();
  parent.abort(new Error("synthetic raw parent reason"));
  let runCalls = 0;

  await assert.rejects(
    withSearchDeadline("searxng", 10, parent.signal, async () => {
      runCalls++;
      return "unexpected";
    }),
    (error: unknown) => {
      assert.ok(error instanceof WebSearchError);
      assert.equal(error.code, "cancelled");
      assert.equal(error.message, "Web search was cancelled.");
      assert.doesNotMatch(error.message, /synthetic raw parent reason/);
      return true;
    },
  );
  assert.equal(runCalls, 0);
  assert.equal(getEventListeners(parent.signal, "abort").length, 0);
});

test("withSearchDeadline: distinguishes timeout from parent cancellation", async () => {
  const parent = new AbortController();
  let runCalls = 0;
  const operation = withSearchDeadline(
    "codex-alpha-search",
    1_000,
    parent.signal,
    async () => {
      runCalls++;
      return new Promise<never>(() => {});
    },
  );
  assert.equal(runCalls, 1);
  parent.abort(new Error("synthetic raw parent reason"));

  await assert.rejects(settleWithin(operation), (error: unknown) => {
    assert.ok(error instanceof WebSearchError);
    assert.equal(error.code, "cancelled");
    assert.equal(error.provider, "codex-alpha-search");
    assert.doesNotMatch(error.message, /synthetic raw parent reason/);
    return true;
  });
});

test("withSearchDeadline: removes listeners and clears its timer after success", async () => {
  const parent = new AbortController();
  let deadlineSignal: AbortSignal | undefined;
  const result = await withSearchDeadline(
    "searxng",
    25,
    parent.signal,
    async (signal) => {
      deadlineSignal = signal;
      assert.equal(getEventListeners(parent.signal, "abort").length, 1);
      assert.equal(getEventListeners(signal, "abort").length, 1);
      return "done";
    },
  );

  assert.equal(result, "done");
  assert.ok(deadlineSignal);
  assert.equal(getEventListeners(parent.signal, "abort").length, 0);
  assert.equal(getEventListeners(deadlineSignal, "abort").length, 0);
  await new Promise<void>((resolve) => setTimeout(resolve, 40));
  assert.equal(deadlineSignal.aborted, false);
});

test("fetchJson: accepts exactly 1 MiB from a streamed body", async () => {
  const payload = `{${" ".repeat(MAX_RESPONSE_BYTES - 2)}}`;
  const midpoint = MAX_RESPONSE_BYTES / 2;
  const response = responseFromChunks([
    bytes(payload.slice(0, midpoint)),
    bytes(payload.slice(midpoint)),
  ]);
  const fetcher: FetchLike = async () => response;

  const parsed = await fetchJson(
    fetcher,
    "searxng",
    "https://example.test/search",
    { signal: new AbortController().signal },
  );
  assert.deepEqual(parsed, {});
});

test("fetchJson: rejects an oversized streamed body and cancels its reader", async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(MAX_RESPONSE_BYTES));
      controller.enqueue(new Uint8Array(1));
    },
    cancel() {
      cancelled = true;
    },
  });
  const response = new Response(body, { status: 200 });

  await assert.rejects(
    fetchJson(async () => response, "searxng", "https://example.test/search", {
      signal: new AbortController().signal,
    }),
    (error: unknown) =>
      error instanceof WebSearchError && error.code === "invalid-response",
  );
  assert.equal(cancelled, true);
});

test("fetchJson: cancellation aborts body consumption and removes its listener", async () => {
  const controller = new AbortController();
  let readStartedResolve: (() => void) | undefined;
  const readStarted = new Promise<void>((resolve) => {
    readStartedResolve = resolve;
  });
  let queued = false;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(streamController) {
      if (!queued) {
        queued = true;
        streamController.enqueue(bytes('{"partial":'));
        return;
      }
      readStartedResolve?.();
      return new Promise<void>(() => {});
    },
    cancel() {
      cancelled = true;
    },
  });
  const response = new Response(body, { status: 200 });
  const operation = fetchJson(
    async () => response,
    "searxng",
    "https://example.test/search",
    { signal: controller.signal },
  );

  await readStarted;
  assert.equal(getEventListeners(controller.signal, "abort").length, 1);
  controller.abort(
    new WebSearchError("cancelled", "Web search was cancelled.", {
      provider: "searxng",
    }),
  );
  await assert.rejects(settleWithin(operation), (error: unknown) => {
    assert.ok(error instanceof WebSearchError);
    assert.equal(error.code, "cancelled");
    return true;
  });
  assert.equal(cancelled, true);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("fetchJson: invalid JSON and HTTP statuses expose safe classified errors", async () => {
  await assert.rejects(
    fetchJson(
      async () => new Response("synthetic response body", { status: 200 }),
      "searxng",
      "https://example.test/search",
      { signal: new AbortController().signal },
    ),
    (error: unknown) => {
      assert.ok(error instanceof WebSearchError);
      assert.equal(error.code, "invalid-response");
      assert.doesNotMatch(error.message, /synthetic response body/i);
      return true;
    },
  );

  await assert.rejects(
    fetchJson(
      async () => new Response("synthetic status secret", { status: 401 }),
      "searxng",
      "https://example.test/search",
      { signal: new AbortController().signal },
    ),
    (error: unknown) => {
      assert.ok(error instanceof WebSearchError);
      assert.equal(error.code, "auth");
      assert.equal(error.status, 401);
      assert.doesNotMatch(error.message, /synthetic status secret/i);
      return true;
    },
  );
});

test("fetchJson: rejects redirects and requests fetch to use the error policy", async () => {
  let redirectPolicy: RequestRedirect | undefined;
  const response = new Response("{}", { status: 200 });
  Object.defineProperty(response, "redirected", { value: true });

  await assert.rejects(
    fetchJson(
      async (_input, init) => {
        redirectPolicy = init?.redirect;
        return response;
      },
      "searxng",
      "https://example.test/search",
      { signal: new AbortController().signal },
    ),
    (error: unknown) => {
      assert.ok(error instanceof WebSearchError);
      assert.equal(error.code, "invalid-response");
      assert.match(error.message, /redirects are not allowed/i);
      return true;
    },
  );
  assert.equal(redirectPolicy, "error");
});
