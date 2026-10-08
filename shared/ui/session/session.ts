import {
  assertUIEvent,
  assertUIEventForView,
  assertUIView,
  type UIEvent,
  type UIView,
} from "../protocol/index.ts";
import type {
  UICloseResult,
  UICloseStatus,
  UIMount,
  UIPort,
  UISession,
  UISessionOptions,
} from "./types.ts";

export class UISessionClosedError extends Error {
  constructor() {
    super("UI session is closing or closed.");
    this.name = "UISessionClosedError";
  }
}

/** Own snapshots/events so caller mutation cannot bypass validation. */
function immutableCopy<T>(value: T): T {
  const copy = structuredClone(value);
  const pending: object[] = [copy as object];
  while (pending.length) {
    const current = pending.pop();
    if (!current) break;
    for (const child of Object.values(current)) {
      if (child !== null && typeof child === "object") pending.push(child);
    }
    Object.freeze(current);
  }
  return copy;
}

interface PendingEvent {
  event: UIEvent;
  resolve(): void;
  reject(error: unknown): void;
}

/** One view/controller/adapter binding; no registrations or global host state. */
export function createUISession(
  initial: UIView,
  options: UISessionOptions,
): UISession {
  assertUIView(initial);
  let snapshot = immutableCopy(initial);
  const controller = new AbortController();
  const listeners = new Set<{ notify: () => void }>();
  const queue: PendingEvent[] = [];
  let processing = false;
  let mountSettled = false;
  let mount: UIMount | undefined;
  let closing = false;
  let finalizing = false;
  let status: UICloseStatus = "completed";
  let failed = false;
  let failure: unknown;
  let settle!: (result: UICloseResult) => void;
  const closed = new Promise<UICloseResult>((resolve) => {
    settle = resolve;
  });

  const rememberFailure = (error: unknown) => {
    if (!failed) {
      failed = true;
      failure = error;
    }
    if (status !== "aborted") status = "error";
  };
  const result = (): UICloseResult =>
    failed ? { status, error: failure } : { status };

  const finalize = async () => {
    if (!closing || !mountSettled || processing || finalizing) return;
    finalizing = true;
    try {
      await mount?.dispose();
    } catch (error) {
      rememberFailure(error);
    }
    try {
      await options.onClosed?.(result());
    } catch (error) {
      rememberFailure(error);
    }
    settle(result());
  };

  const finish = (nextStatus: UICloseStatus, error?: unknown) => {
    if (closing) return;
    closing = true;
    status = nextStatus;
    if (nextStatus === "error") rememberFailure(error);
    options.signal?.removeEventListener("abort", abort);
    listeners.clear();
    for (const pending of queue.splice(0)) {
      pending.reject(new UISessionClosedError());
    }
    controller.abort();
    void finalize();
  };
  const abort = () => finish("aborted");
  const ensureOpen = () => {
    if (closing) throw new UISessionClosedError();
  };

  const drain = async () => {
    if (processing) return;
    processing = true;
    try {
      while (!closing && queue.length) {
        const pending = queue.shift();
        if (!pending) break;
        try {
          // Revalidate at execution time: earlier events may publish a new view.
          assertUIEventForView(snapshot, pending.event);
        } catch (error) {
          pending.reject(error);
          continue;
        }
        try {
          await options.onEvent(pending.event, session);
          pending.resolve();
        } catch (error) {
          rememberFailure(error);
          finish("error", error);
          pending.reject(error);
        }
      }
    } finally {
      processing = false;
      void finalize();
    }
  };

  const session: UISession = {
    signal: controller.signal,
    closed,
    getSnapshot: () => snapshot,
    subscribe(listener) {
      ensureOpen();
      const subscription = { notify: listener };
      listeners.add(subscription);
      return () => {
        listeners.delete(subscription);
      };
    },
    publish(view) {
      ensureOpen();
      assertUIView(view);
      if (view.id !== snapshot.id || view.revision <= snapshot.revision) {
        throw new Error("UI snapshot must keep its ID and increase revision.");
      }
      snapshot = immutableCopy(view);
      for (const listener of [...listeners]) {
        if (closing) break;
        if (!listeners.has(listener)) continue;
        try {
          listener.notify();
        } catch (error) {
          finish("error", error);
          throw error;
        }
      }
    },
    dispatch(event) {
      try {
        ensureOpen();
        assertUIEvent(event);
        const copy = immutableCopy(event);
        return new Promise<void>((resolve, reject) => {
          queue.push({ event: copy, resolve, reject });
          void drain();
        });
      } catch (error) {
        return Promise.reject(error);
      }
    },
    close: (nextStatus = "completed") => finish(nextStatus),
  };

  const port: UIPort = {
    signal: session.signal,
    getSnapshot: session.getSnapshot,
    subscribe: session.subscribe,
    dispatch: session.dispatch,
  };

  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  // Defer mount so the caller receives the session before callbacks can run.
  void Promise.resolve().then(async () => {
    try {
      if (!closing) {
        mount = await options.adapter.mount(port);
        if (!mount || typeof mount.dispose !== "function") {
          throw new Error("UI adapter must return a disposable mount.");
        }
        if (!closing) await options.onOpen?.();
      }
    } catch (error) {
      rememberFailure(error);
      finish("error", error);
    } finally {
      mountSettled = true;
      void finalize();
    }
  });

  return session;
}
