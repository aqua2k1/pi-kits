import assert from "node:assert/strict";
import { test } from "node:test";
import { WebSearchError } from "../../core/errors.ts";
import {
  buildCodexSearchPayload,
  CODEX_ALPHA_SEARCH_URL,
  createCodexProvider,
} from "./provider.ts";

const auth = {
  accessToken: "fixture-access-token",
  accountId: "fixture-account-123",
};
const request = {
  query: "OpenAI news",
  maxResults: 1,
  domains: ["openai.com"],
  recencyDays: 7,
};

function provider(fetcher: typeof fetch) {
  return createCodexProvider({
    resolveAuth: async () => auth,
    fetch: fetcher,
    requestId: () => "search-id",
  });
}

test("Codex validates model and deadline settings before any auth or transport", () => {
  for (const model of ["", "bad model", "x".repeat(129)]) {
    assert.throws(
      () => createCodexProvider({ model, resolveAuth: async () => auth }),
      WebSearchError,
    );
  }
  assert.throws(
    () =>
      createCodexProvider({ timeoutMs: 999, resolveAuth: async () => auth }),
    WebSearchError,
  );
});

test("Codex payload snapshots mutable request domains", () => {
  const domains = ["openai.com"];
  const payload = buildCodexSearchPayload(
    { query: "test", maxResults: 1, domains },
    "gpt-5.4",
    "search-id",
  );
  domains.push("example.com");
  assert.deepEqual(
    (payload.commands as { search_query: { domains: string[] }[] })
      .search_query[0]?.domains,
    ["openai.com"],
  );
});

test("Codex sends the fixed endpoint, required headers and alpha/search payload", async () => {
  let calledUrl = "";
  let calledInit: RequestInit | undefined;
  const search = provider(async (input, init) => {
    calledUrl = String(input);
    calledInit = init;
    return Response.json({
      output: "A short answer",
      results: [
        {
          title: "OpenAI",
          url: "https://openai.com/",
          snippet: "Official site",
        },
        { title: "Second", url: "https://openai.com/news", text: "second" },
      ],
    });
  });
  const result = await search.search(request);
  assert.equal(calledUrl, CODEX_ALPHA_SEARCH_URL);
  assert.equal(calledInit?.method, "POST");
  assert.equal(calledInit?.redirect, "error");
  const headers = new Headers(calledInit?.headers);
  assert.equal(headers.get("authorization"), `Bearer ${auth.accessToken}`);
  assert.equal(headers.get("chatgpt-account-id"), auth.accountId);
  assert.equal(headers.get("originator"), "pi");
  const payload = {
    id: "search-id",
    model: "gpt-5.4",
    commands: {
      search_query: [{ q: "OpenAI news", recency: 7, domains: ["openai.com"] }],
    },
    settings: { allowed_callers: ["direct"], external_web_access: true },
  };
  assert.deepEqual(
    buildCodexSearchPayload(request, "gpt-5.4", "search-id"),
    payload,
  );
  assert.deepEqual(JSON.parse(String(calledInit?.body)), payload);
  assert.deepEqual(result, {
    query: "OpenAI news",
    summary: "A short answer",
    results: [
      { title: "OpenAI", url: "https://openai.com/", snippet: "Official site" },
    ],
  });
});

test("Codex parses alternate fields and Markdown links through common URL safety", async () => {
  const search = provider(async () =>
    Response.json({
      output:
        "See [OpenAI](https://openai.com) and [bad](https://user:fixture-password@example.com)",
      results: [
        {
          name: "News",
          link: "https://openai.com/news",
          text: "text fallback",
        },
      ],
    }),
  );
  const result = await search.search({ query: "test", maxResults: 3 });
  assert.deepEqual(result.results, [
    { title: "News", url: "https://openai.com/news", snippet: "text fallback" },
    { title: "OpenAI", url: "https://openai.com/", snippet: "" },
  ]);
  assert.doesNotMatch(JSON.stringify(result), /fixture-password/);
});

test("Codex rejects unexpected wire shapes and never includes upstream errors", async () => {
  for (const body of ["not json", "{}", "[]", '{"results":[]}']) {
    await assert.rejects(
      provider(async () => new Response(body)).search(request),
      { code: "invalid-response" },
    );
  }
  await assert.rejects(
    provider(async () =>
      Response.json({ error: auth.accessToken }, { status: 401 }),
    ).search(request),
    (error: unknown) => {
      assert.ok(error instanceof WebSearchError);
      assert.equal(error.code, "auth");
      assert.doesNotMatch(
        `${error.stack} ${JSON.stringify(error)}`,
        /fixture-access-token/,
      );
      return true;
    },
  );
});

test("Codex auth is bounded and late auth completion cannot initiate fetch", async () => {
  const controller = new AbortController();
  const pending = Promise.withResolvers<typeof auth>();
  let calls = 0;
  const search = createCodexProvider({
    resolveAuth: () => pending.promise,
    fetch: async () => {
      calls++;
      return Response.json({ output: "" });
    },
  });
  const result = search.search(request, controller.signal);
  controller.abort(new Error(auth.accessToken));
  await assert.rejects(result, { code: "cancelled" });
  pending.resolve(auth);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 0);
  const hung = createCodexProvider({
    timeoutMs: 1_000,
    resolveAuth: () => new Promise(() => {}),
  });
  await assert.rejects(hung.search(request), { code: "timeout" });
});

test("Codex cancellation really occurs during fetch, not during auth", async () => {
  const controller = new AbortController();
  const started = Promise.withResolvers<void>();
  let fetchSignal: AbortSignal | null | undefined;
  const search = provider(async (_url, init) => {
    fetchSignal = init?.signal;
    started.resolve();
    return new Promise(() => {});
  });
  const result = search.search(request, controller.signal);
  await started.promise;
  controller.abort();
  await assert.rejects(result, { code: "cancelled" });
  assert.equal(fetchSignal?.aborted, true);
});

test("Codex cancellation during body consumption cancels the reader", async () => {
  const controller = new AbortController();
  const started = Promise.withResolvers<void>();
  let cancelled = false;
  const search = provider(
    async () =>
      new Response(
        new ReadableStream({
          pull() {
            started.resolve();
            return new Promise(() => {});
          },
          cancel() {
            cancelled = true;
          },
        }),
      ),
  );
  const result = search.search(request, controller.signal);
  await started.promise;
  controller.abort();
  await assert.rejects(result, { code: "cancelled" });
  assert.equal(cancelled, true);
});
