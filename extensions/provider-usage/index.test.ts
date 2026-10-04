import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { useAgentDir } from "../../tests/helpers/agent-dir.ts";
import { chatgptSource } from "./chatgpt.js";
import providerUsage from "./index.js";
import { INTERVAL_MS, WIDGET_ID } from "./source.js";

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
type Command = Parameters<ExtensionAPI["registerCommand"]>[1];
type Widget = Parameters<ExtensionContext["ui"]["setWidget"]>[1];
type WidgetOptions = Parameters<ExtensionContext["ui"]["setWidget"]>[2];
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

// The host double records only public Pi calls and network requests. It does
// not access closure state, private helpers, fetch generations or cache keys.
function host(t: TestContext, config?: unknown) {
  useAgentDir(t, config);
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const events = new Map<string, Handler[]>();
  const commands = new Map<string, Command>();
  const credentials: string[] = [];
  const requests: string[] = [];
  const requestDetails: Array<{
    url: string;
    authorization: string | null;
    signal: AbortSignal;
  }> = [];
  const notifications: string[] = [];
  let credentialLookup:
    | ((provider: string) => Promise<string | undefined>)
    | undefined;
  let fetchDelay: Promise<void> | undefined;
  let widget: Widget;
  let status = 200;
  let percent = 10;
  let authenticated = true;
  t.mock.method(
    globalThis,
    "fetch",
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const request = new Request(input, init);
      const url = request.url;
      requests.push(url);
      requestDetails.push({
        url,
        authorization: request.headers.get("authorization"),
        signal: request.signal,
      });
      if (fetchDelay) await fetchDelay;
      if (status !== 200) return new Response(null, { status });
      if (url === "https://api.deepseek.com/user/balance") {
        return Response.json({
          is_available: true,
          balance_infos: [{ currency: "CNY", total_balance: "110.00" }],
        });
      }
      assert.equal(url, "https://chatgpt.com/backend-api/wham/usage");
      return Response.json({
        plan_type: "plus",
        rate_limit: {
          primary_window: {
            used_percent: percent,
            limit_window_seconds: 18_000,
            reset_at: 0,
          },
        },
      });
    },
  );
  const ctx = {
    mode: "tui",
    hasUI: true,
    ui: {
      setWidget: (id: string, content: Widget, options?: WidgetOptions) => {
        if (id !== WIDGET_ID) return;
        if (content !== undefined)
          assert.equal(options?.placement, "belowEditor");
        widget = content;
      },
      notify: (message: string) => notifications.push(message),
    },
    modelRegistry: {
      getApiKeyForProvider: async (provider: string) => {
        credentials.push(provider);
        if (credentialLookup) return credentialLookup(provider);
        return authenticated ? "fixture-token" : undefined;
      },
    },
  } as unknown as ExtensionContext;
  const result = providerUsage({
    on: (name: string, handler: Handler) => {
      events.set(name, [...(events.get(name) ?? []), handler]);
      return () => {};
    },
    registerCommand: (name: string, command: Command) =>
      commands.set(name, command),
  } as unknown as ExtensionAPI);
  assert.equal(result, undefined);

  async function emit(name: string, provider?: string) {
    const model = provider === undefined ? undefined : { provider };
    ctx.model = model as ExtensionContext["model"];
    for (const handler of events.get(name) ?? []) {
      await handler({ type: name, model }, ctx);
    }
    await flush();
  }
  t.after(() => emit("session_shutdown"));
  return {
    events,
    commands,
    credentials,
    requests,
    requestDetails,
    notifications,
    emit,
    setCredentialLookup: (
      lookup: (provider: string) => Promise<string | undefined>,
    ) => {
      credentialLookup = lookup;
    },
    setFetchDelay: (delay: Promise<void>) => {
      fetchDelay = delay;
    },
    setStatus: (value: number) => {
      status = value;
    },
    setPercent: (value: number) => {
      percent = value;
    },
    setAuthenticated: (value: boolean) => {
      authenticated = value;
    },
    async tick(ms = INTERVAL_MS) {
      t.mock.timers.tick(ms);
      await flush();
    },
    async usage() {
      const command = commands.get("usage");
      assert.ok(command);
      await command.handler("", ctx as ExtensionCommandContext);
      await flush();
    },
    text() {
      if (!widget) return "";
      if (Array.isArray(widget)) return widget.join("\n");
      const theme = { fg: (color: string, text: string) => `${color}:${text}` };
      const component = widget(
        {} as Parameters<typeof widget>[0],
        theme as Parameters<typeof widget>[1],
      );
      return component.render(200).join("\n");
    },
  };
}

test("extension factory registers its public lifecycle and command without starting I/O", async (t) => {
  const h = host(t);
  await flush();
  for (const event of ["session_start", "model_select", "session_shutdown"]) {
    assert.ok(h.events.has(event));
  }
  assert.ok(h.commands.has("usage"));
  assert.deepEqual(h.credentials, []);
  assert.deepEqual(h.requests, []);
});

test("session and model selection follow source providers without guessing aliases", async (t) => {
  const h = host(t);
  for (const provider of [chatgptSource.provider]) {
    await h.emit("session_start", provider);
    assert.match(h.text(), /ChatGPT/);
    assert.equal(h.credentials.at(-1), chatgptSource.provider);
  }
  await h.emit("model_select", "deepseek");
  assert.match(h.text(), /DeepSeek/);
  assert.equal(h.credentials.at(-1), "deepseek");
  for (const provider of ["openai", "unsupported-provider", undefined]) {
    await h.emit("model_select", provider);
    assert.equal(h.text(), "");
  }
});

test("usage command refreshes and reports warning state through the public UI", async (t) => {
  const h = host(t);
  await h.emit("session_start", chatgptSource.provider);
  assert.match(h.text(), /10%/);
  assert.doesNotMatch(h.text(), /warning:/);
  h.setPercent(80);
  await h.usage();
  assert.match(h.text(), /warning:.*80%/);
  assert.match(h.notifications.at(-1) ?? "", /80%/);
});

test("failed refresh preserves successful usage as stale", async (t) => {
  const h = host(t);
  await h.emit("session_start", chatgptSource.provider);
  h.setStatus(503);
  await h.usage();
  assert.match(h.text(), /10%.*stale/);
  assert.match(h.notifications.at(-1) ?? "", /stale/);
});

test("failure without cached data displays the source placeholder and HTTP reason", async (t) => {
  const h = host(t);
  h.setStatus(503);
  await h.emit("session_start", chatgptSource.provider);
  assert.ok(h.text().includes(chatgptSource.placeholder));
  assert.match(h.text(), /503/);
});

test("authentication recovery messaging comes from the selected source", async (t) => {
  const h = host(t);
  h.setStatus(401);
  await h.emit("session_start", chatgptSource.provider);
  assert.ok(h.text().includes(chatgptSource.authFailureMessage ?? ""));
  await h.emit("model_select", "deepseek");
  assert.match(h.text(), /DeepSeek.*401/);
  assert.doesNotMatch(h.text(), /ChatGPT|openai-codex/);
});

test("missing credentials prevent unauthenticated network requests", async (t) => {
  const h = host(t);
  h.setAuthenticated(false);
  await h.emit("session_start", chatgptSource.provider);
  await h.usage();
  await h.tick();
  assert.deepEqual(h.requests, []);
});

test("polling follows the public interval and ends on session shutdown", async (t) => {
  const h = host(t);
  await h.emit("session_start", chatgptSource.provider);
  const before = h.requests.length;
  await h.tick();
  assert.ok(h.requests.length > before);
  await h.emit("session_shutdown");
  const stopped = h.requests.length;
  await h.tick();
  assert.equal(h.requests.length, stopped);
  assert.equal(h.text(), "");
});

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("shutdown while authentication is pending discards the returned credential", async (t) => {
  const h = host(t);
  await h.emit("session_start", "deepseek");
  const auth = deferred<string>();
  h.setCredentialLookup(() => auth.promise);
  const refresh = h.usage();
  assert.equal(h.credentials.at(-1), "deepseek");
  const before = h.requests.length;

  await h.emit("session_shutdown");
  auth.resolve("late-deepseek-token");

  await assert.doesNotReject(refresh);
  await h.tick();
  assert.equal(h.requests.length, before);
  assert.equal(h.text(), "");
  assert.deepEqual(h.notifications, []);
});

test("switching DeepSeek to Codex never sends a pending old credential to the new endpoint", async (t) => {
  const h = host(t);
  await h.emit("session_start", "deepseek");
  const oldAuth = deferred<string>();
  const codexResponse = deferred<void>();
  t.after(() => codexResponse.resolve());
  h.setFetchDelay(codexResponse.promise);
  h.setCredentialLookup((provider) =>
    provider === "deepseek" ? oldAuth.promise : Promise.resolve("codex-token"),
  );
  const oldRefresh = h.usage();
  assert.equal(h.credentials.at(-1), "deepseek");
  const before = h.requestDetails.length;

  await h.emit("model_select", "openai-codex");
  const codexRequest = h.requestDetails.at(-1);
  assert.ok(codexRequest);
  assert.equal(codexRequest.url, "https://chatgpt.com/backend-api/wham/usage");
  assert.equal(codexRequest.authorization, "Bearer codex-token");
  assert.match(h.text(), /ChatGPT/);

  oldAuth.resolve("old-deepseek-token");
  await flush();

  assert.ok(
    h.requestDetails.every(
      ({ authorization }) => authorization !== "Bearer old-deepseek-token",
    ),
  );
  assert.equal(h.requestDetails.length, before + 1);
  assert.equal(codexRequest.signal.aborted, false);
  codexResponse.resolve();
  await assert.doesNotReject(oldRefresh);
  await flush();
  assert.match(h.text(), /ChatGPT.*10%/);
});

for (const usage of [
  { enabled: false },
  { providerUsage: { enabled: false } },
]) {
  test(`disabled usage ${JSON.stringify(usage)} registers nothing`, async (t) => {
    const h = host(t, { usage });
    assert.equal(h.events.size, 0);
    assert.equal(h.commands.size, 0);
    await h.emit("session_start", "deepseek");
    await h.tick();
    assert.deepEqual(h.requests, []);
    assert.deepEqual(h.credentials, []);
  });
}

test("provider polling and request timeout use configured durations", async (t) => {
  const h = host(t, {
    usage: { providerUsage: { intervalMs: 2_000, timeoutMs: 250 } },
  });
  await h.emit("session_start", "deepseek");
  assert.equal(h.requests.length, 1);
  await h.tick(1_999);
  assert.equal(h.requests.length, 1);

  const response = deferred<void>();
  t.after(() => response.resolve());
  h.setFetchDelay(response.promise);
  await h.tick(1);
  assert.equal(h.requests.length, 2);
  const request = h.requestDetails.at(-1);
  assert.ok(request);
  await h.tick(249);
  assert.equal(request.signal.aborted, false);
  await h.tick(1);
  assert.equal(request.signal.aborted, true);
  response.resolve();
  await flush();
});
