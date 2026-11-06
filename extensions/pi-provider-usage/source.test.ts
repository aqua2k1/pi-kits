import assert from "node:assert/strict";
import { test } from "node:test";
import { chatgptSource } from "./chatgpt.js";
import { deepseekSource } from "./deepseek.js";
import { HttpError, type UsageData, type WidgetSource } from "./source.js";

// Fixtures describe the external service contracts, not parser internals.
const cases: Array<{
  name: string;
  source: WidgetSource;
  url: string;
  response: unknown;
  empty: unknown;
  amounts?: number[];
  currencies?: string[];
}> = [
  {
    name: "ChatGPT",
    source: chatgptSource,
    url: "https://chatgpt.com/backend-api/wham/usage",
    response: {
      plan_type: "plus",
      rate_limit: {
        primary_window: {
          used_percent: 10,
          limit_window_seconds: 18_000,
          reset_at: 0,
        },
      },
    },
    empty: { rate_limit: null },
  },
  {
    name: "DeepSeek",
    source: deepseekSource,
    url: "https://api.deepseek.com/user/balance",
    response: {
      is_available: true,
      balance_infos: [
        {
          currency: "CNY",
          total_balance: "110.00",
          granted_balance: "10.00",
          topped_up_balance: "100.00",
        },
        {
          currency: "USD",
          total_balance: "5.50",
          granted_balance: "0.00",
          topped_up_balance: "5.50",
        },
      ],
    },
    empty: { is_available: false, balance_infos: [] },
    amounts: [110, 5.5],
    currencies: ["CNY", "USD"],
  },
];

function assertUsage(data: UsageData): void {
  assert.equal(typeof data.line, "string");
  assert.ok(data.line.length > 0);
  assert.ok(Array.isArray(data.windows));
  for (const window of data.windows) {
    assert.equal(typeof window.label, "string");
    assert.equal(typeof window.percent, "number");
  }
  if (data.amounts) {
    assert.ok(Array.isArray(data.amounts));
    assert.ok(data.amounts.every((amount) => typeof amount === "number"));
  }
}

for (const {
  name,
  source,
  url,
  response,
  empty,
  amounts,
  currencies,
} of cases) {
  test(`${name} fetch accepts caller credentials and returns UsageData`, async (t) => {
    const token = "fixture-token";
    let requested = false;
    t.mock.method(
      globalThis,
      "fetch",
      async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const request = new Request(input, init);
        assert.equal(request.url, url);
        assert.equal(request.method, "GET");
        assert.equal(request.headers.get("authorization"), `Bearer ${token}`);
        requested = true;
        return Response.json(response);
      },
    );

    const result = await source.fetch(token, new AbortController().signal);

    assert.ok(requested);
    assert.ok(result);
    assertUsage(result);
    assert.match(result.line, new RegExp(name));
    if (amounts) assert.deepEqual(result.amounts, amounts);
    for (const currency of currencies ?? []) {
      assert.ok(result.line.includes(currency));
    }
  });

  test(`${name} fetch represents unavailable data without fabricated usage`, async (t) => {
    t.mock.method(globalThis, "fetch", async () => Response.json(empty));
    const result = await source.fetch(
      "fixture-token",
      new AbortController().signal,
    );
    if (result !== undefined) {
      assertUsage(result);
      assert.equal(result.line, source.placeholder);
      assert.deepEqual(result.windows, []);
    }
  });

  test(`${name} fetch rejects HTTP failures with their status`, async (t) => {
    for (const status of [401, 429, 503]) {
      t.mock.method(
        globalThis,
        "fetch",
        async () => new Response(null, { status }),
      );
      await assert.rejects(
        source.fetch("fixture-token", new AbortController().signal),
        (error: unknown) =>
          error instanceof HttpError && error.status === status,
      );
    }
  });

  test(`${name} fetch honors caller cancellation`, async (t) => {
    t.mock.method(
      globalThis,
      "fetch",
      async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        assert.ok(init?.signal);
        init.signal.throwIfAborted();
        return Response.json(response);
      },
    );
    await assert.rejects(source.fetch("fixture-token", AbortSignal.abort()), {
      name: "AbortError",
    });
  });

  test(`${name} isWarning accepts empty usage without reporting a warning`, () => {
    assert.equal(source.isWarning({ line: "", windows: [] }), false);
  });
}

// ChatGPT documents >= 80%. DeepSeek documents an any-currency warning;
// its numeric threshold is not assumed from a private constant.
test("ChatGPT isWarning follows the documented usage threshold for any window", () => {
  for (const [percent, warning] of [
    [79.99, false],
    [80, true],
    [100, true],
  ] as const) {
    const data: UsageData = {
      line: "arbitrary display text",
      windows: [
        { label: "first", percent: 0 },
        { label: "second", percent },
      ],
    };
    assert.equal(chatgptSource.isWarning(data), warning);
  }
});

test("DeepSeek isWarning combines currency warnings without assuming a private threshold", () => {
  const amounts = [0, 100];
  const data = (values: number[]): UsageData => ({
    line: "arbitrary display text",
    windows: [],
    amounts: values,
  });
  const warnings = amounts.map((amount) =>
    deepseekSource.isWarning(data([amount])),
  );
  for (const warning of warnings) assert.equal(typeof warning, "boolean");
  assert.equal(deepseekSource.isWarning(data(amounts)), warnings.some(Boolean));
});

test("HttpError is an Error carrying the supplied HTTP status", () => {
  for (const status of [401, 429, 503]) {
    const error = new HttpError(status);
    assert.ok(error instanceof Error);
    assert.equal(error.status, status);
    assert.equal(typeof error.message, "string");
  }
});
