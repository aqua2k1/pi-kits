import assert from "node:assert/strict";
import { test } from "node:test";
import { GhRequestError } from "../../shared/gh-request.ts";
import { WebSearchError } from "../errors.ts";
import type { SearchResponse } from "../types.ts";
import { searchGitHub } from "./service.ts";
import {
  GITHUB_SEARCH_KINDS,
  type GitHubSearchKind,
  type GitHubSearchOptions,
  type GitHubSearchRequest,
} from "./types.ts";

const request: GitHubSearchRequest = {
  kind: "repositories",
  query: "example",
  maxResults: 3,
};
const repository = {
  full_name: "acme/project",
  html_url: "https://github.com/acme/project",
  description: "Useful project",
};
const code = {
  name: "index.ts",
  path: "src/index.ts",
  repository: { full_name: "acme/project" },
  html_url: "https://github.com/acme/project/blob/main/src/index.ts",
};
const issue = {
  title: "Fix bug",
  body: "Details",
  html_url: "https://github.com/acme/project/issues/12",
};
const pull = {
  ...issue,
  html_url: "https://github.com/acme/project/pull/12",
  pull_request: {},
};
const commit = {
  sha: "a".repeat(40),
  html_url: `https://github.com/acme/project/commit/${"a".repeat(40)}`,
  commit: { message: "Fix bug\n\nMore details" },
};

function wire(items: unknown[] = [repository], extra = {}) {
  return {
    total_count: items.length,
    incomplete_results: false,
    items,
    ...extra,
  };
}

function setup(
  respond: NonNullable<GitHubSearchOptions["request"]> = async () => wire(),
) {
  const calls: {
    endpoint: string;
    options: Parameters<NonNullable<GitHubSearchOptions["request"]>>[1];
  }[] = [];
  const options: GitHubSearchOptions = {
    timeoutMs: 1000,
    async request(endpoint, options) {
      calls.push({ endpoint, options });
      return respond(endpoint, options);
    },
  };
  return { calls, options };
}

for (const [kind, item, title, snippet] of [
  ["repositories", repository, "acme/project", "Useful project"],
  ["code", code, "acme/project: index.ts", "acme/project/src/index.ts"],
  ["issues", issue, "Fix bug", "Details"],
  ["pull-requests", pull, "Fix bug", "Details"],
  ["commits", commit, "Fix bug", "Fix bug More details"],
] as const) {
  test(`${kind}: one REST request, isolated response contract`, async () => {
    const { calls, options } = setup(async () => wire([item]));
    const signal = new AbortController().signal;
    const response: SearchResponse = await searchGitHub(
      { ...request, kind },
      options,
      signal,
    );
    assert.deepEqual(response, {
      query: "example",
      results: [{ title, url: item.html_url, snippet }],
    });
    assert.equal(calls.length, 1);
    const [endpoint, search] = calls[0].endpoint.split("?");
    assert.equal(
      endpoint,
      `search/${kind === "pull-requests" ? "issues" : kind}`,
    );
    const params = new URLSearchParams(search);
    assert.equal(
      params.get("q"),
      kind === "issues" || kind === "pull-requests"
        ? `(example) AND is:${kind === "issues" ? "issue" : "pr"}`
        : "example",
    );
    assert.equal(params.get("per_page"), "3");
    assert.equal(params.get("page"), "1");
    assert.equal(
      params.get("advanced_search"),
      kind === "issues" || kind === "pull-requests" ? "true" : null,
    );
    assert.equal(calls[0].options.timeoutMs, 1000);
    assert.equal(calls[0].options.signal, signal);
    if (kind === "code") {
      assert.equal(
        calls[0].options.accept,
        "application/vnd.github.text-match+json",
      );
    } else {
      assert.ok(!("accept" in calls[0].options));
    }
    assert.ok(!("provider" in response));
    assert.ok(!("source" in response));
  });
}

test("kind enumeration is the public inventory", () => {
  assert.deepEqual(GITHUB_SEARCH_KINDS, [
    "repositories",
    "code",
    "issues",
    "pull-requests",
    "commits",
  ]);
});

test("query is encoded once, including Unicode, reserved characters and percent escapes", async () => {
  const { options, calls } = setup(async () => wire([]));
  const query = '  repo:acme/project "中文 + & ? # %2F"  ';
  await searchGitHub(
    { ...request, kind: "code", query, maxResults: 10 },
    options,
  );
  const params = new URLSearchParams(calls[0].endpoint.split("?")[1]);
  assert.equal(params.get("q"), query.trim());
  assert.equal(params.get("per_page"), "10");
  assert.ok(!calls[0].endpoint.includes("#"));
});

for (const kind of ["issues", "pull-requests"] as const) {
  for (const query of [
    "is:pr",
    "is:issue",
    "-is:pr",
    'is:"pr"',
    '"is:issue"',
    "TYPE:issue",
    "-type:pr",
    "foo OR bar",
    "foo or bar",
    "NOT foo",
    "(foo)",
    "foo AND bar",
    "foo\\ bar",
    "is:pull-request",
    "type:pull-requests",
    "IS : 'pr'",
    'foo "unterminated',
    "foo 'unterminated",
    "doesn't work",
    "error handling and retries",
  ]) {
    test(`${kind} delegates native query syntax ${query}`, async () => {
      const { options, calls } = setup(async () => wire([]));
      await searchGitHub({ ...request, kind, query }, options);
      assert.equal(calls.length, 1);
      const params = new URLSearchParams(calls[0].endpoint.split("?")[1]);
      assert.equal(
        params.get("q"),
        `(${query}) AND is:${kind === "issues" ? "issue" : "pr"}`,
      );
    });
  }
  for (const qualifier of [
    "is:open",
    "is:closed",
    "is:merged",
    "is:unmerged",
    "is:draft",
    "-is:open",
    'is:"closed"',
    "type:open",
  ]) {
    test(`${kind} permits native non-resource qualifier ${qualifier}`, async () => {
      const { options, calls } = setup(async () => wire([]));
      const query = `repo:acme/project ${qualifier} label:bug "bug fix"`;
      await searchGitHub({ ...request, kind, query }, options);
      assert.equal(calls.length, 1);
      const params = new URLSearchParams(calls[0].endpoint.split("?")[1]);
      assert.equal(
        params.get("q"),
        `(${query}) AND is:${kind === "issues" ? "issue" : "pr"}`,
      );
    });
  }
}

for (const kind of ["issues", "pull-requests"] as const) {
  test(`${kind} applies its kind constraint to the whole Boolean expression`, async () => {
    const expected = kind === "issues" ? issue : pull;
    const { options } = setup(async (endpoint) => {
      const query = new URLSearchParams(endpoint.split("?")[1]).get("q");
      assert.equal(
        new URLSearchParams(endpoint.split("?")[1]).get("advanced_search"),
        "true",
      );
      // An ungrouped first branch can match either resource type.
      return query ===
        `(foo OR bar) AND is:${kind === "issues" ? "issue" : "pr"}`
        ? wire([expected])
        : wire([issue, pull]);
    });
    const response = await searchGitHub(
      { ...request, kind, query: "foo OR bar" },
      options,
    );
    assert.deepEqual(
      response.results.map((result) => result.url),
      [expected.html_url],
    );
  });
}

for (const patch of [
  { kind: "unknown" },
  { query: "" },
  { query: "x".repeat(2001) },
  { query: 42 },
  { query: "foo\u0000bar" },
  { query: "\ud800" },
  ...[0, -1, 11, 1.5, NaN, Infinity, "3", undefined].map((maxResults) => ({
    maxResults,
  })),
  { domains: [] },
  { domains: undefined },
  { recencyDays: 1 },
  { recencyDays: undefined },
]) {
  test(`invalid input makes no request: ${JSON.stringify(patch)}`, async () => {
    const { options, calls } = setup();
    await assert.rejects(
      searchGitHub({ ...request, ...patch } as GitHubSearchRequest, options),
      WebSearchError,
    );
    assert.equal(calls.length, 0);
  });
}

for (const timeoutMs of [0, 999, 120001, NaN, Infinity, 1000.5]) {
  test(`invalid timeout ${timeoutMs} makes no request`, async () => {
    const { options, calls } = setup();
    await assert.rejects(searchGitHub(request, { ...options, timeoutMs }), {
      code: "invalid-config",
    });
    assert.equal(calls.length, 0);
  });
}

test("code uses text_matches, with absent/empty matches falling back to path", async () => {
  for (const text_matches of [
    undefined,
    [],
    [{ fragment: "" }],
    [{ fragment: "const x = 1;" }, { fragment: "use(x)" }],
  ]) {
    const { options } = setup(async () =>
      wire([
        { ...code, ...(text_matches === undefined ? {} : { text_matches }) },
      ]),
    );
    const response = await searchGitHub({ ...request, kind: "code" }, options);
    assert.equal(
      response.results[0].snippet,
      text_matches?.length === 2
        ? "const x = 1; use(x)"
        : "acme/project/src/index.ts",
    );
  }
});

for (const raw of [
  null,
  [],
  "bad",
  {},
  wire([], { total_count: -1 }),
  wire([], { total_count: 1.5 }),
  wire([], { total_count: Number.MAX_SAFE_INTEGER + 1 }),
  wire([], { total_count: "0" }),
  wire([], { incomplete_results: "false" }),
  { items: [], total_count: 0 },
  wire([], { items: {} }),
  wire([repository], { total_count: 0 }),
  wire(Array(101).fill(repository)),
  wire([null]),
  wire([{}]),
  wire([{ ...repository, description: false }]),
  wire([{ ...repository, full_name: "" }]),
]) {
  test(`strict envelope/repository validation: ${JSON.stringify(raw)?.slice(0, 100)}`, async () => {
    const { options, calls } = setup(async () => raw);
    await assert.rejects(searchGitHub(request, options), {
      code: "invalid-response",
    });
    assert.equal(calls.length, 1);
  });
}

for (const [kind, item] of [
  ["code", { ...code, name: null }],
  ["code", { ...code, repository: {} }],
  ["code", { ...code, path: "" }],
  ["code", { ...code, text_matches: null }],
  ["code", { ...code, text_matches: [null] }],
  ["code", { ...code, text_matches: [{ fragment: 1 }] }],
  ["issues", pull],
  ["pull-requests", issue],
  ["issues", { ...issue, body: {} }],
  ["issues", { ...issue, title: "" }],
  ["pull-requests", { ...pull, pull_request: null }],
  ["commits", { ...commit, commit: {} }],
  ["commits", { ...commit, sha: null }],
] as const) {
  test(`strict ${kind} item validation: ${JSON.stringify(item)}`, async () => {
    const { options } = setup(async () => wire([item]));
    await assert.rejects(searchGitHub({ ...request, kind }, options), {
      code: "invalid-response",
    });
  });
}

for (const html_url of [
  "http://github.com/acme/project",
  "https://evil.test/acme/project",
  "https://github.com.evil.test/acme/project",
  "https://api.github.com/acme/project",
  "https://user:pass@github.com/acme/project",
  "https://github.com:8443/acme/project",
  "javascript:alert(1)",
  "//github.com/acme/project",
  "https://github.com\\@evil.test/repo",
  "https://github.com/acme/\nproject",
  "not a URL",
]) {
  test(`unsafe result URL is rejected: ${html_url}`, async () => {
    const { options } = setup(async () => wire([{ ...repository, html_url }]));
    await assert.rejects(searchGitHub(request, options), {
      code: "invalid-response",
    });
  });
}

test("strict validation includes entries beyond maxResults", async () => {
  const { options } = setup(async () => wire([repository, null]));
  await assert.rejects(searchGitHub({ ...request, maxResults: 1 }, options), {
    code: "invalid-response",
  });
});

test("null descriptions and issue bodies are valid", async () => {
  for (const [kind, item] of [
    ["repositories", { ...repository, description: null }],
    ["issues", { ...issue, body: null }],
  ] as const) {
    const { options } = setup(async () => wire([item]));
    assert.equal(
      (await searchGitHub({ ...request, kind }, options)).results[0].snippet,
      "",
    );
  }
});

test("empty, incomplete and total_count responses preserve truncation", async () => {
  for (const [raw, truncated] of [
    [wire([]), undefined],
    [wire([], { incomplete_results: true }), true],
    [wire([repository], { total_count: 20 }), true],
  ] as const) {
    const { options } = setup(async () => raw);
    assert.equal((await searchGitHub(request, options)).truncated, truncated);
  }
});

test("limit and helper deduplication are bounded and marked truncated", async () => {
  const { options } = setup(async () =>
    wire([
      repository,
      {
        ...repository,
        html_url: `${repository.html_url}?utm_source=test#fragment`,
      },
      { ...repository, html_url: "https://github.com/acme/second" },
      { ...repository, html_url: "https://github.com/acme/third" },
    ]),
  );
  const response = await searchGitHub({ ...request, maxResults: 2 }, options);
  assert.equal(response.results.length, 2);
  assert.equal(response.results[1].url, "https://github.com/acme/second");
  assert.equal(response.truncated, true);
});

test("shared helpers bound UTF-8 title/snippet/URL and sanitize text and query", async () => {
  const { options } = setup(async () =>
    wire([
      {
        ...repository,
        full_name: "中".repeat(1000),
        description: "中".repeat(3000),
      },
    ]),
  );
  const response = await searchGitHub(
    { ...request, query: "password=secret" },
    options,
  );
  assert.ok(Buffer.byteLength(response.results[0].title) <= 500);
  assert.ok(Buffer.byteLength(response.results[0].snippet) <= 2000);
  assert.ok(!JSON.stringify(response).includes("�"));
  assert.equal(response.query, "password=[redacted]");
  assert.equal(response.truncated, true);
  const longUrl = setup(async () =>
    wire([
      {
        ...repository,
        html_url: `https://github.com/acme/${"x".repeat(2100)}`,
      },
    ]),
  );
  const skipped = await searchGitHub(request, longUrl.options);
  assert.equal(skipped.results.length, 0);
  assert.equal(skipped.truncated, true);
});

test("environment credentials, nested URLs and terminal controls are redacted", async () => {
  const previous = process.env.GH_TOKEN;
  process.env.GH_TOKEN = "ghp_super_sensitive_example";
  try {
    const secret = process.env.GH_TOKEN;
    const { options } = setup(async () =>
      wire([
        {
          ...repository,
          full_name: `\u001b[31m${secret}`,
          html_url: `${repository.html_url}?token=secret&next=https%3A%2F%2Fx.test%2F%3Fpassword%3Dsecret#private`,
          description: `Bearer secret ${Buffer.from(secret).toString("base64")} password=secret https://x.test/?token=secret`,
        },
      ]),
    );
    const response = await searchGitHub({ ...request, query: secret }, options);
    const serialized = JSON.stringify(response);
    assert.ok(!serialized.includes(secret));
    assert.ok(!serialized.includes(Buffer.from(secret).toString("base64")));
    assert.ok(!serialized.includes("password=secret"));
    assert.ok(!serialized.includes("token=secret"));
    assert.ok(!serialized.includes("\\u001b"));
    assert.ok(!response.results[0].url.includes("#"));
    assert.match(response.query, /redacted/);
  } finally {
    if (previous === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = previous;
  }
});

for (const [error, expected] of [
  [new GhRequestError("auth"), "auth"],
  [new GhRequestError("status", 401), "auth"],
  [new GhRequestError("status", 403), "auth"],
  [new GhRequestError("status", 429), "rate-limit"],
  [new GhRequestError("rate-limit", 403), "rate-limit"],
  [new GhRequestError("status", 422), "unsupported"],
  [new GhRequestError("status", 500), "server"],
  [new GhRequestError("status", 400), "request"],
  [new GhRequestError("status", 504), "timeout"],
  [new GhRequestError("status"), "invalid-response"],
  [new GhRequestError("request"), "request"],
  [new GhRequestError("network"), "network"],
  [new GhRequestError("timeout"), "timeout"],
  [new GhRequestError("cancelled"), "cancelled"],
  [new GhRequestError("invalid-response"), "invalid-response"],
  [new GhRequestError("tool-unavailable"), "unsupported"],
  [new Error("SECRET upstream diagnostic"), "network"],
  [
    new WebSearchError("auth", "SECRET auth diagnostic", {
      provider: "SECRET",
      status: 401,
    }),
    "auth",
  ],
  [new DOMException("SECRET abort", "AbortError"), "cancelled"],
] as const) {
  test(`safe error classification ${error.name}/${expected}, no retry`, async () => {
    if (!(error instanceof DOMException)) {
      error.message = `SECRET ${error.message}`;
    }
    const { options, calls } = setup(async () => {
      throw error;
    });
    await assert.rejects(searchGitHub(request, options), (caught: unknown) => {
      assert.ok(caught instanceof WebSearchError);
      assert.equal(caught.code, expected);
      assert.equal(caught.provider, "github-gh");
      assert.ok(!JSON.stringify(caught).includes("SECRET"));
      assert.ok(!caught.message.includes("SECRET"));
      assert.equal(caught.cause, undefined);
      return true;
    });
    assert.equal(calls.length, 1);
  });
}

test("pre-cancelled requests make no call", async () => {
  const controller = new AbortController();
  controller.abort("SECRET");
  const { options, calls } = setup();
  await assert.rejects(searchGitHub(request, options, controller.signal), {
    code: "cancelled",
    provider: "github-gh",
  });
  assert.equal(calls.length, 0);
});

test("in-flight cancellation propagates to transport and defeats a late success/failure", async () => {
  for (const throws of [true, false]) {
    const controller = new AbortController();
    const { options, calls } = setup(async (_endpoint, options) => {
      assert.equal(options.signal, controller.signal);
      controller.abort("SECRET");
      if (throws) throw new GhRequestError("network");
      return wire();
    });
    await assert.rejects(searchGitHub(request, options, controller.signal), {
      code: "cancelled",
      provider: "github-gh",
    });
    assert.equal(calls.length, 1);
  }
});

// Compile-time independent request contract and structural response compatibility.
const compileTimeKind: GitHubSearchKind = "code";
void compileTimeKind;
