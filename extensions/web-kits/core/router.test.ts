import assert from "node:assert/strict";
import { test } from "node:test";
import { WebSearchError } from "./errors.ts";
import { WebSearchRouter } from "./router.ts";
import type { SearchProvider, SearchRequest, SearchResponse } from "./types.ts";

const request: SearchRequest = { query: "test", maxResults: 2 };

function response(query = "test"): SearchResponse {
  return { query, results: [] };
}

function provider(search: SearchProvider["search"]): SearchProvider {
  return { search };
}

test("WebSearchRouter: uses injected providers without runtime dependencies", async () => {
  const factoryCalls: string[] = [];
  let received: SearchRequest | undefined;
  let receivedSignal: AbortSignal | undefined;
  const router = new WebSearchRouter({
    searxng: () => {
      factoryCalls.push("searxng");
      return provider(async (input, signal) => {
        received = input;
        receivedSignal = signal;
        return response("[redacted]");
      });
    },
    "codex-alpha-search": () => {
      throw new Error("unused provider factory");
    },
  });

  const result = await router.search(
    { query: "  private query  ", maxResults: 1 },
    { provider: "searxng", fallback: false },
  );

  assert.deepEqual(received, { query: "private query", maxResults: 1 });
  assert.equal(receivedSignal, undefined);
  assert.equal(result.provider, "searxng");
  assert.equal(result.query, "[redacted]");
  assert.deepEqual(factoryCalls, ["searxng"]);
});

test("WebSearchRouter: fallback is opt-in", async () => {
  const noFallbackCalls: string[] = [];
  const noFallbackRouter = new WebSearchRouter({
    searxng: () => {
      noFallbackCalls.push("searxng");
      return provider(async () => {
        throw new WebSearchError("network", "safe network failure");
      });
    },
    "codex-alpha-search": () => {
      noFallbackCalls.push("codex-alpha-search");
      return provider(async () => response("fallback"));
    },
  });

  await assert.rejects(
    noFallbackRouter.search(request, {
      provider: "searxng",
      fallback: false,
    }),
    (error: unknown) =>
      error instanceof WebSearchError && error.code === "network",
  );
  assert.deepEqual(noFallbackCalls, ["searxng"]);

  const fallbackCalls: string[] = [];
  const fallbackRouter = new WebSearchRouter({
    searxng: () => {
      fallbackCalls.push("searxng");
      return provider(async () => {
        throw new WebSearchError("network", "safe network failure");
      });
    },
    "codex-alpha-search": () => {
      fallbackCalls.push("codex-alpha-search");
      return provider(async () => response("fallback"));
    },
  });

  const result = await fallbackRouter.search(request, {
    provider: "searxng",
    fallback: true,
  });
  assert.equal(result.provider, "codex-alpha-search");
  assert.equal(result.query, "fallback");
  assert.deepEqual(fallbackCalls, ["searxng", "codex-alpha-search"]);
});

test("WebSearchRouter: uses the configured fallback provider", async () => {
  const calls: string[] = [];
  const router = new WebSearchRouter({
    searxng: () => {
      calls.push("searxng");
      return provider(async () => response("searxng"));
    },
    "codex-alpha-search": () => {
      calls.push("codex-alpha-search");
      return provider(async () => {
        throw new WebSearchError("network", "safe network failure");
      });
    },
  });

  const result = await router.search(request, {
    provider: "codex-alpha-search",
    fallback: true,
    fallbackProvider: "searxng",
  });
  assert.equal(result.provider, "searxng");
  assert.deepEqual(calls, ["codex-alpha-search", "searxng"]);
});

test("WebSearchRouter: does not fallback invalid-config, request, or cancelled failures", async () => {
  for (const code of ["invalid-config", "request", "cancelled"] as const) {
    const calls: string[] = [];
    const router = new WebSearchRouter({
      searxng: () => {
        calls.push("searxng");
        return provider(async () => {
          throw new WebSearchError(code, `safe ${code} failure`);
        });
      },
      "codex-alpha-search": () => {
        calls.push("codex-alpha-search");
        return provider(async () => response("fallback"));
      },
    });

    await assert.rejects(
      router.search(request, { provider: "searxng", fallback: true }),
      (error: unknown) =>
        error instanceof WebSearchError && error.code === code,
    );
    assert.deepEqual(calls, ["searxng"], code);
  }
});

test("WebSearchRouter: exhaustion reports safe per-attempt error codes", async () => {
  const calls: string[] = [];
  const router = new WebSearchRouter({
    searxng: () => {
      calls.push("searxng");
      return provider(async () => {
        throw new Error("synthetic-secret response body");
      });
    },
    "codex-alpha-search": () => {
      calls.push("codex-alpha-search");
      return provider(async () => {
        throw new WebSearchError("auth", "safe authentication failure");
      });
    },
  });

  await assert.rejects(
    router.search(request, { provider: "searxng", fallback: true }),
    (error: unknown) => {
      assert.ok(error instanceof WebSearchError);
      assert.equal(error.code, "auth");
      assert.match(
        error.message,
        /Tried: searxng \(network\), codex-alpha-search \(auth\)\./,
      );
      assert.doesNotMatch(error.message, /synthetic-secret|response body/i);
      return true;
    },
  );
  assert.deepEqual(calls, ["searxng", "codex-alpha-search"]);
});

test("WebSearchRouter: cancellation between attempts does not start fallback", async () => {
  const controller = new AbortController();
  const calls: string[] = [];
  const router = new WebSearchRouter({
    searxng: () => {
      calls.push("searxng");
      return provider(async (_input, signal) => {
        assert.equal(signal, controller.signal);
        controller.abort(new Error("synthetic parent reason"));
        throw new WebSearchError("network", "safe network failure");
      });
    },
    "codex-alpha-search": () => {
      calls.push("codex-alpha-search");
      return provider(async () => response("fallback"));
    },
  });

  await assert.rejects(
    router.search(
      request,
      { provider: "searxng", fallback: true },
      controller.signal,
    ),
    (error: unknown) => {
      assert.ok(error instanceof WebSearchError);
      assert.equal(error.code, "cancelled");
      assert.doesNotMatch(error.message, /synthetic parent reason/);
      return true;
    },
  );
  assert.deepEqual(calls, ["searxng"]);
});

test("WebSearchRouter: pre-cancelled requests do not construct a provider", async () => {
  const controller = new AbortController();
  controller.abort(new Error("synthetic parent reason"));
  const calls: string[] = [];
  const router = new WebSearchRouter({
    searxng: () => {
      calls.push("searxng");
      return provider(async () => response());
    },
    "codex-alpha-search": () => {
      calls.push("codex-alpha-search");
      return provider(async () => response());
    },
  });

  await assert.rejects(
    router.search(
      request,
      { provider: "searxng", fallback: true },
      controller.signal,
    ),
    (error: unknown) =>
      error instanceof WebSearchError && error.code === "cancelled",
  );
  assert.deepEqual(calls, []);
});
