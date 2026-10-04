import assert from "node:assert/strict";
import { test } from "node:test";
import { chatgptSource } from "./chatgpt.js";

// Public contracts: WidgetSource.fetch, documented window labels, and the
// existing multi-window countdown requirement. No private helpers are accessed.
test("ChatGPT fetch returns usage and countdowns for every reported window", async (t) => {
  const now = 1_700_000_000_000;
  const windows = [
    {
      label: "5h",
      seconds: 5 * 60 * 60,
      percent: 10,
      remaining: "2h0m",
      ms: 7_200_000,
    },
    {
      label: "weekly",
      seconds: 7 * 24 * 60 * 60,
      percent: 20,
      remaining: "3d0h",
      ms: 259_200_000,
    },
    {
      label: "monthly",
      seconds: 30 * 24 * 60 * 60,
      percent: 30,
      remaining: "24d0h",
      ms: 2_073_600_000,
    },
  ];
  const rateLimit = Object.fromEntries(
    windows.map((window, index) => [
      ["primary_window", "secondary_window", "monthly_window"][index],
      {
        used_percent: window.percent,
        limit_window_seconds: window.seconds,
        reset_at: (now + window.ms) / 1000,
      },
    ]),
  );
  t.mock.method(Date, "now", () => now);
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({ plan_type: "plus", rate_limit: rateLimit }),
  );

  const result = await chatgptSource.fetch(
    "fixture-token",
    new AbortController().signal,
  );

  assert.ok(result);
  assert.match(result.line, /ChatGPT.*plus/);
  assert.deepEqual(
    new Map(result.windows.map(({ label, percent }) => [label, percent])),
    new Map(windows.map(({ label, percent }) => [label, percent])),
  );
  for (const { remaining } of windows) {
    assert.match(result.line, new RegExp(`\\b${remaining}\\b`));
  }
});

test("ChatGPT countdowns keep two units including zero values", async (t) => {
  const now = 1_700_000_000_000;
  t.mock.method(Date, "now", () => now);
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({
      rate_limit: {
        primary_window: {
          used_percent: 10,
          limit_window_seconds: 5 * 60 * 60,
          reset_at: (now + 31 * 60_000) / 1000,
        },
        secondary_window: {
          used_percent: 20,
          limit_window_seconds: 24 * 60 * 60,
          reset_at: (now + 60 * 60_000) / 1000,
        },
        monthly_window: {
          used_percent: 30,
          limit_window_seconds: 30 * 24 * 60 * 60,
          reset_at: (now + 2 * 24 * 60 * 60_000) / 1000,
        },
      },
    }),
  );

  const result = await chatgptSource.fetch(
    "fixture-token",
    new AbortController().signal,
  );

  assert.ok(result);
  assert.match(result.line, /resets in 0h31m\/0d1h\/2d0h/);
});

test("ChatGPT fetch authenticates with the supplied JWT and account claim", async (t) => {
  const accountId = "fixture-account";
  const payload = Buffer.from(
    JSON.stringify({
      "https://api.openai.com/auth": { chatgpt_account_id: accountId },
    }),
  ).toString("base64url");
  const token = `e30.${payload}.fixture-signature`;
  let requested = false;
  t.mock.method(
    globalThis,
    "fetch",
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const request = new Request(input, init);
      assert.equal(request.url, "https://chatgpt.com/backend-api/wham/usage");
      assert.equal(request.method, "GET");
      assert.equal(request.headers.get("authorization"), `Bearer ${token}`);
      assert.equal(request.headers.get("chatgpt-account-id"), accountId);
      requested = true;
      return Response.json({ rate_limit: null });
    },
  );

  await chatgptSource.fetch(token, new AbortController().signal);

  assert.ok(requested);
});
