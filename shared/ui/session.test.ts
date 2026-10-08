import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { UIProtocolError, type UIView } from "@pi-kits/shared/ui/protocol";
import {
  createUISession,
  type UIAdapter,
  type UIMount,
  type UIPort,
  UISessionClosedError,
  type UISessionOptions,
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
      id: "choices",
      label: "Choices",
      type: "multiple",
      value: [],
      options: [{ id: "a", label: "A" }],
    },
  };
}
const dismiss = (revision = 0) => ({
  type: "dismiss",
  viewId: "view",
  revision,
});
function fail(error: unknown): never {
  throw error;
}

// Test-only adapter: no host registrations, rendering or production adapter.
function harness(options: Partial<UISessionOptions> = {}, initial = view()) {
  const mounted = deferred<UIPort>();
  let disposals = 0;
  const adapter: UIAdapter = {
    mount(port) {
      mounted.resolve(port);
      return { dispose: () => void disposals++ };
    },
  };
  const session = createUISession(initial, {
    adapter,
    onEvent: () => {},
    ...options,
  });
  return { session, mounted: mounted.promise, disposals: () => disposals };
}

// Check pending work without timers. Never await closed from lifecycle callbacks.
async function pending(promise: Promise<unknown>) {
  const marker = Symbol("pending");
  assert.equal(await Promise.race([promise, Promise.resolve(marker)]), marker);
}

test("mount is deferred and exposes only the port; dismiss needs explicit close", async () => {
  let opened = 0;
  let events = 0;
  const h = harness({
    onOpen: () => void opened++,
    onEvent: () => void events++,
  });
  assert.equal(opened, 0);
  const port = await h.mounted;
  assert.deepEqual(Object.keys(port).sort(), [
    "dispatch",
    "getSnapshot",
    "signal",
    "subscribe",
  ]);
  assert.equal(port.signal, h.session.signal);
  assert.equal(port.getSnapshot(), h.session.getSnapshot());
  let changes = 0;
  port.subscribe(() => changes++);
  h.session.publish(view(1));
  assert.equal(changes, 1);
  await port.dispatch(dismiss(1));
  assert.equal(opened, 1);
  assert.equal(events, 1);
  await pending(h.session.closed);
  h.session.close("dismissed");
  h.session.close();
  assert.equal(port.signal.aborted, true);
  assert.deepEqual(await h.session.closed, { status: "dismissed" });
  assert.equal(h.disposals(), 1);
  assert.throws(() => port.subscribe(() => {}), UISessionClosedError);
  assert.throws(() => h.session.publish(view(2)), UISessionClosedError);
  await assert.rejects(port.dispatch(dismiss(1)), UISessionClosedError);
});

test("snapshots are deeply frozen clones and invalid publish leaves session open", async () => {
  const initial = view();
  const { session } = harness({}, initial);
  const snapshot = session.getSnapshot();
  initial.root.id = "mutated";
  assert.equal(snapshot.root.id, "choices");
  assert.notEqual(snapshot, initial);
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.root), true);
  assert.ok(
    snapshot.root.kind === "field" && snapshot.root.type === "multiple",
  );
  assert.equal(Object.isFrozen(snapshot.root.options[0]), true);
  assert.equal(Object.isFrozen(snapshot.root.value), true);
  assert.throws(() => (snapshot.root.id = "forbidden"), TypeError);
  for (const invalid of [view(), view(-1), { ...view(1), id: "other" }]) {
    assert.throws(() => session.publish(invalid));
    assert.equal(session.getSnapshot(), snapshot);
    assert.equal(session.signal.aborted, false);
  }
  const next = view(2);
  session.publish(next);
  next.root.id = "changed after publish";
  assert.equal(session.getSnapshot().root.id, "choices");
  assert.equal(snapshot.revision, 0);
  await session.dispatch(dismiss(2));
  session.close();
  assert.deepEqual(await session.closed, { status: "completed" });
});

test("unknown, structurally invalid and wrong-target events reject without closing", async () => {
  const { session } = harness();
  for (const event of [
    null,
    { ...dismiss(), extra: true },
    { ...dismiss(), viewId: "other" },
    dismiss(1),
    { type: "invoke", viewId: "view", revision: 0, nodeId: "missing" },
    { type: "invoke", viewId: "view", revision: 0, nodeId: "choices" },
  ]) {
    const dispatched = session.dispatch(event);
    assert.ok(dispatched instanceof Promise);
    await assert.rejects(dispatched, UIProtocolError);
    assert.equal(session.signal.aborted, false);
  }
  await session.dispatch(dismiss());
  session.close();
  await session.closed;
});

test("async and reentrant events serialize; queued validation uses current snapshot", async () => {
  const gate = deferred();
  const order: string[] = [];
  let reentrant!: Promise<void>;
  const { session } = harness({
    async onEvent(event, current) {
      order.push(`start:${event.revision}`);
      if (event.revision === 0) {
        reentrant = current.dispatch(dismiss(1));
        await gate.promise;
        current.publish(view(1));
      }
      order.push(`end:${event.revision}`);
    },
  });
  const first = session.dispatch(dismiss());
  const stale = assert.rejects(session.dispatch(dismiss()), UIProtocolError);
  assert.deepEqual(order, ["start:0"]);
  gate.resolve();
  await Promise.all([first, stale, reentrant]);
  assert.deepEqual(order, ["start:0", "end:0", "start:1", "end:1"]);
  assert.equal(session.signal.aborted, false);
  session.close();
  await session.closed;
});

test("queued events are owned frozen copies, including nested caller values", async () => {
  const gate = deferred();
  const { session } = harness({
    async onEvent(event) {
      if (event.type === "dismiss") await gate.promise;
      else {
        assert.ok(event.type === "change");
        assert.deepEqual(event.value, ["a"]);
        assert.equal(Object.isFrozen(event), true);
        assert.equal(Object.isFrozen(event.value), true);
      }
    },
  });
  const first = session.dispatch(dismiss());
  const event = {
    type: "change",
    viewId: "view",
    revision: 0,
    nodeId: "choices",
    value: ["a"],
  };
  const second = session.dispatch(event);
  event.nodeId = "missing";
  event.value.push("mutated");
  gate.resolve();
  await Promise.all([first, second]);
  session.close();
  await session.closed;
});

test("close rejects queued work but waits for handler, async dispose and onClosed", async () => {
  const handler = deferred();
  const disposing = deferred();
  const disposed = deferred();
  const closing = deferred();
  const callback = deferred();
  let calls = 0;
  const { session } = harness({
    adapter: {
      mount: () => ({
        async dispose() {
          calls++;
          disposing.resolve();
          await disposed.promise;
        },
      }),
    },
    onEvent: () => handler.promise,
    async onClosed(result) {
      assert.deepEqual(result, { status: "completed" });
      closing.resolve();
      await callback.promise;
    },
  });
  await Promise.resolve();
  const active = session.dispatch(dismiss());
  const queued = assert.rejects(
    session.dispatch(dismiss()),
    UISessionClosedError,
  );
  session.close();
  await queued;
  assert.equal(calls, 0);
  await pending(session.closed);
  handler.resolve();
  await active;
  await disposing.promise;
  await pending(session.closed);
  disposed.resolve();
  await closing.promise;
  await pending(session.closed);
  callback.resolve();
  assert.deepEqual(await session.closed, { status: "completed" });
  session.close();
  assert.equal(calls, 1);
});

test("pre-abort and immediate abort skip mount", async () => {
  for (const preaborted of [true, false]) {
    const controller = new AbortController();
    if (preaborted) controller.abort();
    let mounts = 0;
    const { session } = harness({
      signal: controller.signal,
      adapter: {
        mount() {
          mounts++;
          return { dispose() {} };
        },
      },
    });
    controller.abort();
    assert.deepEqual(await session.closed, { status: "aborted" });
    assert.equal(mounts, 0);
  }
});

test("abort during mount waits, skips onOpen and disposes late mount exactly once", async () => {
  const controller = new AbortController();
  const mount = deferred<UIMount>();
  let opened = 0;
  let disposed = 0;
  const { session } = harness({
    signal: controller.signal,
    adapter: {
      mount(port) {
        assert.equal(port.signal.aborted, false);
        return mount.promise;
      },
    },
    onOpen: () => void opened++,
  });
  await Promise.resolve();
  controller.abort();
  await pending(session.closed);
  mount.resolve({ dispose: () => void disposed++ });
  assert.deepEqual(await session.closed, { status: "aborted" });
  assert.equal(opened, 0);
  assert.equal(disposed, 1);
});

test("mount, onOpen, onEvent, dispose and onClosed failures close with first error", async () => {
  for (const phase of ["mount", "onOpen", "onEvent", "dispose", "onClosed"]) {
    const failure = new Error(phase);
    const cleanup = new Error("later cleanup");
    let disposed = 0;
    const { session } = harness({
      adapter: {
        mount() {
          if (phase === "mount") throw failure;
          return {
            dispose() {
              disposed++;
              if (phase === "dispose") throw failure;
              if (phase !== "onClosed") throw cleanup;
            },
          };
        },
      },
      onOpen() {
        if (phase === "onOpen") throw failure;
      },
      onEvent: async () => fail(failure),
      onClosed: async () => fail(phase === "onClosed" ? failure : cleanup),
    });
    if (phase === "onEvent") {
      const active = assert.rejects(
        session.dispatch(dismiss()),
        (error) => error === failure,
      );
      const queued = assert.rejects(
        session.dispatch(dismiss()),
        UISessionClosedError,
      );
      await Promise.all([active, queued]);
    } else if (phase === "dispose" || phase === "onClosed") {
      await Promise.resolve();
      session.close();
    }
    assert.deepEqual(await session.closed, { status: "error", error: failure });
    assert.equal(disposed, phase === "mount" ? 0 : 1);
  }
});

test("aborted status survives mount rejection and cleanup failure", async () => {
  for (const rejectMount of [true, false]) {
    const controller = new AbortController();
    const mount = deferred<UIMount>();
    const failure = new Error("first failure");
    const { session } = harness({
      signal: controller.signal,
      adapter: { mount: () => mount.promise },
      onClosed: () => fail(new Error("later")),
    });
    await Promise.resolve();
    controller.abort();
    if (rejectMount) mount.reject(failure);
    else mount.resolve({ dispose: async () => fail(failure) });
    assert.deepEqual(await session.closed, {
      status: "aborted",
      error: failure,
    });
  }
});

test("old unsubscribe cannot remove a new subscription of the same listener", async () => {
  const { session } = harness();
  let calls = 0;
  const fn = () => calls++;
  const off = session.subscribe(fn);
  off();
  const off2 = session.subscribe(fn);
  off();
  session.publish(view(1));
  assert.equal(calls, 1);
  off2();
  session.publish(view(2));
  assert.equal(calls, 1);
  session.close();
  await session.closed;
});

test("parallel subscriptions of the same listener are independent", async () => {
  const { session } = harness();
  let calls = 0;
  const fn = () => calls++;
  const off = session.subscribe(fn);
  const off2 = session.subscribe(fn);
  session.publish(view(1));
  assert.equal(calls, 2);
  off();
  session.publish(view(2));
  assert.equal(calls, 3);
  off2();
  session.publish(view(3));
  assert.equal(calls, 3);
  session.close();
  await session.closed;
});

test("unsubscribe during notification is safe; listener failure closes with error", async () => {
  const { session } = harness();
  let calls = 0;
  let unsubscribe = () => {};
  session.subscribe(() => unsubscribe());
  unsubscribe = session.subscribe(() => calls++);
  session.publish(view(1));
  unsubscribe();
  assert.equal(calls, 0);
  const failure = new Error("listener");
  session.subscribe(() => fail(failure));
  session.subscribe(() => calls++);
  assert.throws(
    () => session.publish(view(2)),
    (error) => error === failure,
  );
  assert.equal(calls, 0);
  assert.deepEqual(await session.closed, { status: "error", error: failure });
  unsubscribe();
});

test("background completion rejection closes and disposes exactly once", async () => {
  const completion = deferred();
  const mounted = deferred();
  const failure = new Error("background");
  let disposals = 0;
  const { session } = harness({
    adapter: {
      mount() {
        mounted.resolve();
        return {
          completion: completion.promise,
          dispose: () => void disposals++,
        };
      },
    },
  });
  await mounted.promise;
  completion.reject(failure);
  assert.deepEqual(await session.closed, { status: "error", error: failure });
  session.close();
  assert.equal(disposals, 1);
});

test("closed waits for completion settlement even after dispose", async () => {
  const completion = deferred();
  const disposed = deferred();
  const mounted = deferred();
  const { session } = harness({
    adapter: {
      mount() {
        mounted.resolve();
        return {
          completion: completion.promise,
          dispose: () => disposed.resolve(),
        };
      },
    },
  });
  await mounted.promise;
  session.close();
  await disposed.promise;
  await pending(session.closed);
  completion.resolve();
  assert.deepEqual(await session.closed, { status: "completed" });
});

test("normal completion resolution does not automatically close session", async () => {
  const completion = deferred();
  const mounted = deferred();
  const { session } = harness({
    adapter: {
      mount() {
        mounted.resolve();
        return { completion: completion.promise, dispose() {} };
      },
    },
  });
  await mounted.promise;
  completion.resolve();
  await completion.promise;
  await pending(session.closed);
  assert.equal(session.signal.aborted, false);
  await session.dispatch(dismiss());
  session.close();
  assert.deepEqual(await session.closed, { status: "completed" });
});

test("completion preserves first failure and already-aborted status", async () => {
  for (const aborted of [false, true]) {
    const completion = deferred();
    const mounted = deferred();
    const controller = new AbortController();
    const failure = new Error("first");
    const later = new Error("late completion");
    let disposals = 0;
    const { session } = harness({
      signal: controller.signal,
      adapter: {
        mount() {
          mounted.resolve();
          return {
            completion: completion.promise,
            dispose() {
              disposals++;
              completion.reject(later);
              throw failure;
            },
          };
        },
      },
      onEvent: () => fail(failure),
      onClosed: () => fail(new Error("last")),
    });
    await mounted.promise;
    if (aborted) controller.abort();
    else {
      await assert.rejects(
        session.dispatch(dismiss()),
        (error) => error === failure,
      );
    }
    assert.deepEqual(await session.closed, {
      status: aborted ? "aborted" : "error",
      error: failure,
    });
    assert.equal(disposals, 1);
  }
});

test("public session dependency graph has no host imports or global registrations", () => {
  const visited = new Set<string>();
  function inspect(url: string) {
    if (visited.has(url)) return;
    visited.add(url);
    const source = readFileSync(new URL(url), "utf8");
    assert.doesNotMatch(
      source,
      /register(?:Command|Tool|Shortcut|Flag)|\bpi\.on\s*\(/,
    );
    for (const match of source.matchAll(/\bfrom\s+["']([^"']+)["']/g)) {
      assert.match(match[1], /^\.\.?\//);
      inspect(new URL(match[1], url).href);
    }
  }
  inspect(import.meta.resolve("@pi-kits/shared/ui/session"));
  assert.ok(visited.size >= 3);
});
