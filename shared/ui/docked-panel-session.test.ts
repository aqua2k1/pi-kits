import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  ExtensionUIContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { getKeybindings, type TUI } from "@earendil-works/pi-tui";
import type { DockedPanelCloseStatus } from "./docked-panel/events.ts";
import {
  type DockedPanelComponent,
  runDockedPanel,
} from "./docked-panel/session.ts";

type Result = { cancelled: boolean };
const tui = { requestRender() {} } as TUI;
const theme = {} as Theme;

function harness(
  options: {
    beforeFactory?: () => void;
    hostError?: "before" | "after";
    hostFailure?: Error;
    createError?: boolean;
    disposeError?: boolean | Error;
    openError?: boolean | Error;
    closedError?: boolean | Error;
    cancelError?: Error;
    cancelErrorAfterDone?: boolean;
    interact?: (
      component: DockedPanelComponent,
      done: (result: Result) => void,
    ) => void;
  } = {},
) {
  const order: string[] = [];
  const failure = new Error("failure");
  let disposals = 0;
  let cancels = 0;
  let mounted = false;
  let component: DockedPanelComponent | undefined;
  const ui: Pick<ExtensionUIContext, "custom"> = {
    async custom<T>(
      factory: Parameters<ExtensionUIContext["custom"]>[0],
      customOptions: Parameters<ExtensionUIContext["custom"]>[1],
    ): Promise<T> {
      assert.equal(customOptions, undefined);
      if (options.hostError === "before") throw options.hostFailure ?? failure;
      options.beforeFactory?.();
      return new Promise<T>((resolve, reject) => {
        let finished = false;
        const done = (result: unknown) => {
          if (finished) return;
          finished = true;
          mounted = false;
          order.push("host-restored");
          resolve(result as T);
          component?.dispose();
        };
        try {
          const value = factory(
            tui,
            theme,
            getKeybindings() as Parameters<typeof factory>[2],
            done,
          );
          assert.ok(!(value instanceof Promise));
          component = value as DockedPanelComponent;
          if (options.hostError === "after") {
            order.push("host-restored");
            reject(options.hostFailure ?? failure);
          } else if (!finished) {
            mounted = true;
            options.interact?.(component, done);
          }
        } catch (error) {
          order.push("host-restored");
          reject(error);
        }
      });
    },
  };
  return {
    order,
    failure,
    get disposals() {
      return disposals;
    },
    get cancels() {
      return cancels;
    },
    get component() {
      return component;
    },
    get mounted() {
      return mounted;
    },
    run(signal?: AbortSignal) {
      return runDockedPanel<Result>(
        ui,
        (_tui, _theme, _keys, done) => {
          if (options.createError) throw failure;
          return {
            render: () => [],
            invalidate() {},
            cancel() {
              cancels++;
              if (options.cancelError && !options.cancelErrorAfterDone)
                throw options.cancelError;
              done({ cancelled: true });
              if (options.cancelError) throw options.cancelError;
            },
            dispose() {
              disposals++;
              order.push("dispose");
              if (options.disposeError)
                throw options.disposeError === true
                  ? failure
                  : options.disposeError;
            },
          };
        },
        {
          signal,
          isCancelled: (result) => result.cancelled,
          lifecycle: {
            onOpen() {
              order.push("opened");
              if (options.openError)
                throw options.openError === true ? failure : options.openError;
            },
            onClosed(status: DockedPanelCloseStatus) {
              order.push(`closed:${status}`);
              if (options.closedError)
                throw options.closedError === true
                  ? failure
                  : options.closedError;
            },
          },
        },
      );
    },
  };
}

for (const cancelled of [false, true]) {
  test(`session cleans up once after ${cancelled ? "cancellation" : "completion"}`, async () => {
    const host = harness({
      interact(component, done) {
        if (cancelled) component.cancel();
        else done({ cancelled: false });
        done({ cancelled: true }); // A duplicate host completion cannot re-close.
        component.dispose();
      },
    });
    assert.deepEqual(await host.run(), { cancelled });
    assert.equal(host.disposals, 1);
    assert.deepEqual(host.order, [
      "opened",
      "host-restored",
      "dispose",
      `closed:${cancelled ? "cancelled" : "completed"}`,
    ]);
    host.component?.dispose();
    assert.equal(host.disposals, 1);
  });
}

test("open abort settles host, detaches listener and closes once after cleanup", async () => {
  const controller = new AbortController();
  const listeners = trackListeners(controller.signal);
  const host = harness({
    interact() {
      controller.abort();
    },
  });
  await assert.rejects(host.run(controller.signal), { name: "AbortError" });
  assert.equal(listeners(), 0);
  assert.equal(host.disposals, 1);
  assert.equal(host.cancels, 1);
  assert.deepEqual(host.order, [
    "opened",
    "host-restored",
    "dispose",
    "closed:aborted",
  ]);
});

test("preflight and factory-gap aborts never announce an opened UI", async () => {
  for (const preflight of [true, false]) {
    const controller = new AbortController();
    if (preflight) controller.abort();
    const host = harness({
      beforeFactory() {
        controller.abort();
      },
    });
    await assert.rejects(host.run(controller.signal), { name: "AbortError" });
    assert.ok(
      !host.order.some(
        (item) => item === "opened" || item.startsWith("closed:"),
      ),
    );
    assert.equal(host.disposals, preflight ? 0 : 1);
  }
});

for (const scenario of ["host-before", "create"] as const) {
  test(`session handles ${scenario} errors without duplicate disposal or notifications`, async () => {
    const host = harness({
      hostError: scenario === "host-before" ? "before" : undefined,
      createError: scenario === "create",
      interact(_component, done) {
        done({ cancelled: false });
      },
    });
    await assert.rejects(host.run(), host.failure);
    assert.equal(host.order.filter((item) => item === "opened").length, 0);
    assert.equal(host.disposals, 0);
    assert.deepEqual(
      host.order.filter((item) => item.startsWith("closed:")),
      [],
    );
  });
}

function trackListeners(signal: AbortSignal) {
  let count = 0;
  const add = signal.addEventListener.bind(signal);
  const remove = signal.removeEventListener.bind(signal);
  signal.addEventListener = (...args: Parameters<typeof add>) => {
    count++;
    add(...args);
  };
  signal.removeEventListener = (...args: Parameters<typeof remove>) => {
    count--;
    remove(...args);
  };
  return () => count;
}

for (const cancelErrorAfterDone of [false, true]) {
  test("asynchronous abort with throwing cancel settles the host before rejecting", {
    timeout: 2000,
  }, async () => {
    const controller = new AbortController();
    const listeners = trackListeners(controller.signal);
    const cancellation = new Error("cancel failed");
    const cleanup = new Error("dispose failed");
    const closed = new Error("closed failed");
    const host = harness({
      cancelError: cancellation,
      cancelErrorAfterDone,
      disposeError: cleanup,
      closedError: closed,
    });
    const rejected = assert.rejects(
      host.run(controller.signal),
      (error) => error === cancellation,
    );
    await Promise.resolve(); // Abort after the factory returns and host mounts.
    assert.equal(host.mounted, true);
    assert.equal(listeners(), 1);
    assert.doesNotThrow(() => controller.abort(new Error("abort reason")));
    await rejected;
    assert.equal(host.mounted, false);
    assert.equal(listeners(), 0);
    assert.equal(host.cancels, 1);
    assert.equal(host.disposals, 1);
    assert.deepEqual(host.order, [
      "opened",
      "host-restored",
      "dispose",
      "closed:aborted",
    ]);
    host.component?.dispose();
    assert.equal(host.disposals, 1);
  });
}

for (const preflight of [true, false]) {
  test(`throwing cancel with ${preflight ? "preflight" : "factory-gap"} abort does not leak UI`, {
    timeout: 2000,
  }, async () => {
    const controller = new AbortController();
    const listeners = trackListeners(controller.signal);
    const cancellation = new Error("cancel failed");
    const reason = new Error("abort reason");
    if (preflight) controller.abort(reason);
    const host = harness({
      beforeFactory() {
        controller.abort(reason);
      },
      cancelError: cancellation,
      disposeError: new Error("dispose failed"),
      closedError: new Error("closed failed"),
    });
    await assert.rejects(
      host.run(controller.signal),
      (error) => error === (preflight ? reason : cancellation),
    );
    assert.equal(host.mounted, false);
    assert.equal(listeners(), 0);
    assert.equal(host.cancels, preflight ? 0 : 1);
    assert.equal(host.disposals, preflight ? 0 : 1);
    assert.deepEqual(host.order, preflight ? [] : ["host-restored", "dispose"]);
    host.component?.dispose();
    assert.equal(host.disposals, preflight ? 0 : 1);
  });
}

for (const source of ["host", "abort", "open", "dispose", "closed"] as const) {
  test(`closed callback cannot mask the first ${source} failure`, async () => {
    const controller = new AbortController();
    const listeners = trackListeners(controller.signal);
    const hostFailure = new Error("host failed");
    const abortReason = new Error("abort reason");
    const openFailure = new Error("open failed");
    const disposeFailure = new Error("dispose failed");
    const closedFailure = new Error("closed failed");
    const original = {
      host: hostFailure,
      abort: abortReason,
      open: openFailure,
      dispose: disposeFailure,
      closed: closedFailure,
    }[source];
    const host = harness({
      hostError: source === "host" ? "after" : undefined,
      hostFailure,
      openError: source === "open" ? openFailure : undefined,
      disposeError: source !== "closed" ? disposeFailure : undefined,
      closedError: closedFailure,
      interact(_component, done) {
        if (source === "abort") controller.abort(abortReason);
        else done({ cancelled: false });
      },
    });
    await assert.rejects(
      host.run(controller.signal),
      (error) => error === original,
    );
    assert.equal(listeners(), 0);
    assert.equal(host.disposals, 1);
    assert.deepEqual(host.order, [
      "opened",
      "host-restored",
      "dispose",
      `closed:${source === "abort" ? "aborted" : source === "closed" ? "completed" : "error"}`,
    ]);
    host.component?.dispose();
    assert.equal(host.disposals, 1);
  });
}
