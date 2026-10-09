import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  bindUIHost,
  classifyUIFailure,
  createUIHost,
  type UIHostBinding,
  UIHostBusyError,
  UIHostDisposedError,
  type UIHostOutcome,
} from "@pi-kits/shared/ui/host";
import {
  type UIEvent,
  UIProtocolError,
  type UIView,
} from "@pi-kits/shared/ui/protocol";
import type {
  UIAdapter,
  UICloseResult,
  UIMount,
  UIPort,
} from "@pi-kits/shared/ui/session";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function view(revision = 0): UIView {
  return {
    id: "view",
    revision,
    root: {
      kind: "field",
      id: "text",
      label: "Name",
      type: "text",
      value: "current",
      placeholder: "hint",
    },
  };
}

const dismiss = (revision = 0) => ({
  type: "dismiss" as const,
  viewId: "view",
  revision,
});
const ignoreEvent = () => {};
const config = { timeout: 5_000 };

function assertObjectKeys(host: object) {
  assert.deepEqual(Object.keys(host).sort(), ["dispose", "open"]);
}

function assertDisposedOutcome(outcome: UIHostOutcome) {
  assert.equal(outcome.status, "aborted");
  assert.ok(outcome.error instanceof DOMException);
  assert.equal(outcome.error.name, "AbortError");
  assert.equal(outcome.error.message, "UI host disposed.");
}

test("public host outcome aliases the session close result", () => {
  const raw: UICloseResult = { status: "aborted", error: "custom reason" };
  const outcome: UIHostOutcome = raw;
  const roundTrip: UICloseResult = outcome;
  assert.equal(roundTrip, raw);
});

function mockAdapter(mount: UIMount = { dispose() {} }) {
  const mounted = deferred<UIPort>();
  const ports: UIPort[] = [];
  let disposals = 0;
  const adapter: UIAdapter = {
    mount(port) {
      ports.push(port);
      mounted.resolve(port);
      return {
        completion: mount.completion,
        dispose() {
          disposals++;
          return mount.dispose();
        },
      };
    },
  };
  return {
    adapter,
    ports,
    mounted: mounted.promise,
    disposals: () => disposals,
  };
}

async function pending(promise: Promise<unknown>) {
  const marker = Symbol("pending");
  assert.equal(await Promise.race([promise, Promise.resolve(marker)]), marker);
}

type DialogRequest = {
  kind: "select" | "input";
  title: string;
  labels: string[];
  placeholder?: string;
  signal: AbortSignal;
  answer(value?: string): void;
};

// Pi-compatible local dialogs: abort resolves undefined, never registers UI.
function dialogs() {
  const queued: DialogRequest[] = [];
  let waiter: ((request: DialogRequest) => void) | undefined;
  let calls = 0;
  const enqueue = (
    kind: DialogRequest["kind"],
    title: string,
    labels: string[],
    placeholder: string | undefined,
    signal: AbortSignal | undefined,
  ) => {
    assert.ok(signal);
    calls++;
    return new Promise<string | undefined>((resolve) => {
      const answer = (value?: string) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      };
      const abort = () => answer();
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      const request = { kind, title, labels, placeholder, signal, answer };
      if (waiter) {
        const notify = waiter;
        waiter = undefined;
        notify(request);
      } else queued.push(request);
    });
  };
  const ui: UIHostBinding["ui"] = {
    select: (title, labels, options) =>
      enqueue("select", title, labels, undefined, options?.signal),
    input: (title, placeholder, options) =>
      enqueue("input", title, [], placeholder, options?.signal),
  };
  return {
    ui,
    calls: () => calls,
    next() {
      const request = queued.shift();
      if (request) return Promise.resolve(request);
      assert.equal(waiter, undefined);
      return new Promise<DialogRequest>((resolve) => {
        waiter = resolve;
      });
    },
  };
}

test("host forwards snapshots and controller hooks", config, async () => {
  const h = mockAdapter();
  const host = createUIHost(h.adapter);
  const initial = view();
  const opened = deferred();
  const events: UIEvent[] = [];
  let closedCalls = 0;
  const session = host.open(initial, {
    onOpen: () => opened.resolve(),
    onEvent(event, current) {
      assert.equal(current, session);
      events.push(event);
      if (event.type === "dismiss") current.close("dismissed");
      else current.publish(view(1));
    },
    onClosed(result) {
      closedCalls++;
      assert.deepEqual(result, { status: "dismissed" });
    },
  });
  assert.equal(h.ports.length, 0);
  const port = await h.mounted;
  await opened.promise;
  assert.equal(port.getSnapshot(), session.getSnapshot());
  assert.notEqual(port.getSnapshot(), initial);
  initial.root.id = "mutated";
  assert.equal(port.getSnapshot().root.id, "text");
  assert.equal(Object.isFrozen(port.getSnapshot().root), true);
  let updates = 0;
  port.subscribe(() => updates++);
  const change = {
    type: "change" as const,
    viewId: "view",
    revision: 0,
    nodeId: "text",
    value: "new",
  };
  await port.dispatch(change);
  assert.deepEqual(events, [change]);
  assert.notEqual(events[0], change);
  assert.equal(updates, 1);
  assert.equal(port.getSnapshot().revision, 1);
  await port.dispatch(dismiss(1));
  assert.deepEqual(await session.closed, { status: "dismissed" });
  assert.equal(closedCalls, 1);
  assert.equal(h.disposals(), 1);
  assertObjectKeys(host);
  await host.dispose();
});

test("invalid view does not acquire a lease", config, async () => {
  const h = mockAdapter();
  const first = createUIHost(h.adapter);
  const second = createUIHost(h.adapter);
  assert.throws(
    () => first.open(view(-1), { onEvent: ignoreEvent }),
    UIProtocolError,
  );
  assert.equal(h.ports.length, 0);
  const session = second.open(view(), { onEvent: ignoreEvent });
  await h.mounted;
  session.close();
  await session.closed;
  const reused = first.open(view(), { onEvent: ignoreEvent });
  reused.close();
  await reused.closed;
  await Promise.all([first.dispose(), second.dispose()]);
});

test("lease lasts through all cleanup phases", config, async () => {
  const disposal = deferred();
  const disposing = deferred();
  const completion = deferred();
  const closing = deferred();
  const closedCallback = deferred();
  const h = mockAdapter({
    completion: completion.promise,
    dispose() {
      disposing.resolve();
      return disposal.promise;
    },
  });
  const first = createUIHost(h.adapter);
  const second = createUIHost(h.adapter);
  const session = first.open(view(), {
    onEvent: ignoreEvent,
    onClosed() {
      closing.resolve();
      return closedCallback.promise;
    },
  });
  await h.mounted;
  const busy = () => {
    for (const host of [first, second]) {
      assert.throws(
        () => host.open(view(), { onEvent: ignoreEvent }),
        UIHostBusyError,
      );
    }
  };
  busy();
  session.close();
  await disposing.promise;
  busy();
  await pending(session.closed);
  disposal.resolve();
  await pending(session.closed);
  busy();
  completion.resolve();
  await closing.promise;
  busy();
  await pending(session.closed);
  closedCallback.resolve();
  await session.closed;
  const reused = second.open(view(), { onEvent: ignoreEvent });
  reused.close();
  await reused.closed;
  assert.equal(h.disposals(), 1);
  await Promise.all([first.dispose(), second.dispose()]);
});

test("dispose is idempotent and forbids reopening", config, async () => {
  const disposal = deferred();
  const disposing = deferred();
  const closing = deferred();
  const closedCallback = deferred();
  const h = mockAdapter({
    dispose() {
      disposing.resolve();
      return disposal.promise;
    },
  });
  const host = createUIHost(h.adapter);
  const session = host.open(view(), {
    onEvent: ignoreEvent,
    onClosed() {
      closing.resolve();
      return closedCallback.promise;
    },
  });
  await h.mounted;
  const done = host.dispose();
  assert.equal(host.dispose(), done);
  assertObjectKeys(host);
  assert.equal(session.signal.aborted, true);
  assert.throws(
    () => host.open(view(), { onEvent: ignoreEvent }),
    UIHostDisposedError,
  );
  await disposing.promise;
  await pending(done);
  disposal.resolve();
  await closing.promise;
  await pending(done);
  assert.equal(host.dispose(), done);
  closedCallback.resolve();
  await done;
  assertDisposedOutcome(await session.closed);
  assert.equal(host.dispose(), done);
  assert.equal(h.disposals(), 1);
  const fresh = createUIHost(h.adapter);
  assertObjectKeys(fresh);
  const next = fresh.open(view(), { onEvent: ignoreEvent });
  next.close();
  await next.closed;
  await fresh.dispose();
});

test("request abort allows reuse of the host", config, async () => {
  const h = mockAdapter();
  const host = createUIHost(h.adapter);
  for (const preAborted of [false, true]) {
    const request = new AbortController();
    const reason = new Error("request cancelled");
    if (preAborted) request.abort(reason);
    const outcomes: UIHostOutcome[] = [];
    const session = host.open(view(), {
      signal: request.signal,
      onEvent: ignoreEvent,
      onClosed(outcome) {
        outcomes.push(outcome);
      },
    });
    if (!preAborted) {
      await h.mounted;
      request.abort(reason);
    }
    assert.deepEqual(await session.closed, {
      status: "aborted",
      error: reason,
    });
    assert.deepEqual(outcomes, [{ status: "aborted", error: reason }]);
    assert.equal(request.signal.reason, reason);
    assertObjectKeys(host);
  }
  const opened = deferred();
  const next = host.open(view(), {
    onEvent: ignoreEvent,
    onOpen: () => opened.resolve(),
  });
  await opened.promise;
  assert.equal(h.ports.length, 2);
  next.close();
  await next.closed;
  await host.dispose();
});

test("lifetime abort preserves reason, not peers", config, async () => {
  const h = mockAdapter();
  const controller = new AbortController();
  const host = createUIHost(h.adapter, { signal: controller.signal });
  const peer = createUIHost(h.adapter);
  assertObjectKeys(host);
  assertObjectKeys(peer);
  const session = host.open(view(), { onEvent: ignoreEvent });
  await h.mounted;
  const reason = { cause: "context cancelled" };
  controller.abort(reason);
  assert.deepEqual(await session.closed, { status: "aborted", error: reason });
  const preAborted = host.open(view(), { onEvent: ignoreEvent });
  assert.deepEqual(await preAborted.closed, {
    status: "aborted",
    error: reason,
  });
  assert.equal(h.ports.length, 1);
  const next = peer.open(view(), { onEvent: ignoreEvent });
  next.close();
  await next.closed;
  await Promise.all([host.dispose(), peer.dispose()]);
});

test("competing aborts report the effective reason", config, async () => {
  for (const first of ["lifetime", "request", "pre-aborted"]) {
    const h = mockAdapter();
    const lifetime = new AbortController();
    const request = new AbortController();
    const lifetimeReason = { source: "lifetime" };
    const requestReason = { source: "request" };
    if (first === "pre-aborted") {
      request.abort(requestReason);
      lifetime.abort(lifetimeReason);
    }
    const host = createUIHost(h.adapter, { signal: lifetime.signal });
    assertObjectKeys(host);
    const outcomes: UIHostOutcome[] = [];
    const session = host.open(view(), {
      signal: request.signal,
      onEvent: ignoreEvent,
      onClosed(outcome) {
        outcomes.push(outcome);
      },
    });
    if (first !== "pre-aborted") {
      await h.mounted;
      if (first === "request") {
        request.abort(requestReason);
        lifetime.abort(lifetimeReason);
      } else {
        lifetime.abort(lifetimeReason);
        request.abort(requestReason);
      }
    }
    const expected: UIHostOutcome = {
      status: "aborted",
      error: first === "request" ? requestReason : lifetimeReason,
    };
    assert.deepEqual(await session.closed, expected);
    assert.deepEqual(outcomes, [expected]);
    assert.equal(h.ports.length, first === "pre-aborted" ? 0 : 1);
    await host.dispose();
  }
});

test("bindings share leases, not session ownership", config, async () => {
  const d = dialogs();
  const owner = bindUIHost({ hasUI: true, ui: d.ui });
  const idle = bindUIHost({ hasUI: true, ui: d.ui });
  assert.notEqual(owner, idle);
  assertObjectKeys(owner);
  assertObjectKeys(idle);
  const session = owner.open(view(), { onEvent: ignoreEvent });
  assert.throws(
    () => idle.open(view(), { onEvent: ignoreEvent }),
    UIHostBusyError,
  );
  const request = await d.next();
  await idle.dispose();
  assert.equal(request.signal.aborted, false);
  assert.equal(session.signal.aborted, false);
  await pending(session.closed);
  // Even identical methods on a different object must get a separate adapter.
  const other = bindUIHost({ hasUI: true, ui: { ...d.ui } });
  const independent = other.open(view(), { onEvent: ignoreEvent });
  await d.next();
  await other.dispose();
  assertDisposedOutcome(await independent.closed);
  assert.equal(session.signal.aborted, false);
  await owner.dispose();
  assertDisposedOutcome(await session.closed);
  const fresh = bindUIHost({ hasUI: true, ui: d.ui });
  const reused = fresh.open(view(), { onEvent: ignoreEvent });
  await d.next();
  await fresh.dispose();
  assertDisposedOutcome(await reused.closed);
});

test("binder checks UI and never caches signals", config, async () => {
  const d = dialogs();
  assert.throws(() => bindUIHost({ hasUI: false, ui: d.ui }), /unavailable/i);
  assert.equal(d.calls(), 0);
  const a = new AbortController();
  const b = new AbortController();
  const first = bindUIHost({ hasUI: true, ui: d.ui, signal: a.signal });
  const second = bindUIHost({ hasUI: true, ui: d.ui, signal: b.signal });
  assert.equal(d.calls(), 0);
  const session = first.open(view(), { onEvent: ignoreEvent });
  const request = await d.next();
  const reasonA = new Error("first context");
  a.abort(reasonA);
  assert.equal(request.signal.aborted, true);
  assert.deepEqual(await session.closed, { status: "aborted", error: reasonA });
  assertObjectKeys(first);
  assertObjectKeys(second);
  const next = second.open(view(), { onEvent: ignoreEvent });
  await d.next();
  const reasonB = new Error("second context");
  b.abort(reasonB);
  assert.deepEqual(await next.closed, { status: "aborted", error: reasonB });
  assert.deepEqual(await session.closed, { status: "aborted", error: reasonA });
  const preAborted = bindUIHost({ hasUI: true, ui: d.ui, signal: a.signal });
  assertObjectKeys(preAborted);
  const skipped = preAborted.open(view(), { onEvent: ignoreEvent });
  assert.deepEqual(await skipped.closed, { status: "aborted", error: reasonA });
  assert.equal(d.calls(), 2);
  await Promise.all([first.dispose(), second.dispose(), preAborted.dispose()]);
});

test("dialogs render; controller controls cancel", config, async () => {
  const d = dialogs();
  const host = bindUIHost({ hasUI: true, ui: d.ui });
  const initial = view();
  initial.root = {
    kind: "group",
    id: "group",
    title: "Question",
    children: [
      {
        kind: "content",
        id: "intro",
        body: "Visible explanation",
        format: "text",
      },
      initial.root,
    ],
  };
  const events: UIEvent[] = [];
  let dismissals = 0;
  const session = host.open(initial, {
    onEvent(event, current) {
      events.push(event);
      if (event.type === "dismiss" && ++dismissals === 2) {
        current.close("dismissed");
      }
    },
  });
  let request = await d.next();
  assert.match(request.title, /Question/);
  assert.match(request.title, /Visible explanation/);
  assert.match(request.title, /Name: current/);
  assert.match(request.labels[0], /Edit: Name/);
  request.answer(request.labels[0]);
  request = await d.next();
  assert.equal(request.kind, "input");
  assert.match(request.title, /Current value: current/);
  assert.equal(request.placeholder, "hint");
  request.answer(); // Cancelling an edit emits no business event.
  request = await d.next();
  assert.deepEqual(events, []);
  request.answer(request.labels[0]);
  request = await d.next();
  request.answer("updated");
  request = await d.next();
  assert.deepEqual(events, [
    {
      type: "change",
      viewId: "view",
      revision: 0,
      nodeId: "text",
      value: "updated",
    },
  ]);
  request.answer(); // Main-menu cancel is only a dismiss event.
  request = await d.next();
  assert.deepEqual(events[1], dismiss());
  assert.equal(session.signal.aborted, false);
  await pending(session.closed);
  request.answer(request.labels.at(-1));
  assert.deepEqual(await session.closed, { status: "dismissed" });
  assert.deepEqual(events[2], dismiss());
  await host.dispose();
});

test("callback failure wins over cleanup errors", config, async () => {
  const completion = deferred();
  const failure = new Error("controller failed");
  const backgroundFailure = new Error("background failed");
  const cleanupFailure = new Error("onClosed failed");
  const h = mockAdapter({
    completion: completion.promise,
    dispose() {
      completion.reject(backgroundFailure);
    },
  });
  const host = createUIHost(h.adapter);
  const session = host.open(view(), {
    onEvent() {
      throw failure;
    },
    onClosed(result) {
      assert.equal(result.error, failure);
      throw cleanupFailure;
    },
  });
  await h.mounted;
  await assert.rejects(
    session.dispatch(dismiss()),
    (error) => error === failure,
  );
  assert.deepEqual(await session.closed, { status: "error", error: failure });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(h.disposals(), 1);
  const next = host.open(view(), { onEvent: ignoreEvent });
  next.close();
  await next.closed;
  await host.dispose();
});

test("legacy failure classification stays in shared UI", () => {
  const request = new AbortController();
  assert.equal(classifyUIFailure(), "error");
  assert.equal(classifyUIFailure(request.signal), "error");
  request.abort(new Error("caller cancelled"));
  assert.equal(classifyUIFailure(request.signal), "aborted");
});

test("business and host architecture boundaries", () => {
  const interaction = readFileSync(
    new URL(
      "../../extensions/ask-user-question/interaction.ts",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(interaction, /@pi-kits\/shared\/ui\/host/);
  assert.doesNotMatch(
    interaction,
    /PiDialog|PiSDK|@earendil-works|\b(?:context|ctx|select|input)\b|\badapters?\b|createUIHost|bindUIHost|register(?:Tool|Command)/,
  );
  assert.doesNotMatch(
    interaction,
    /host\.signal|\bsignal\?*\.aborted|throwIfAborted/,
  );
  const entry = readFileSync(
    new URL("../../extensions/ask-user-question/index.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(entry, /\.aborted\b|host\??\.signal/);
  assert.match(entry, /askTui \? classifyUIFailure\(signal\) : "error"/);
  for (const path of [
    "host.ts",
    "binding.ts",
    "index.ts",
    "types.ts",
    "lifecycle.ts",
  ]) {
    const source = readFileSync(
      new URL(`./host/${path}`, import.meta.url),
      "utf8",
    );
    assert.doesNotMatch(
      source,
      /register(?:Tool|Command|Shortcut|MessageRenderer|Provider)|globalThis|\bpi\.on\s*\(/,
    );
  }
});
