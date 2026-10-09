import type { UIView } from "../protocol/index.ts";
import {
  createUISession,
  type UIAdapter,
  type UISession,
} from "../session/index.ts";
import type {
  UIHost,
  UIHostOptions,
  UIHostOutcome,
  UIOpenOptions,
} from "./types.ts";

// Active adapter leases only, not reusable global hosts or operation contexts.
const leases = new WeakMap<UIAdapter, UISession>();

export class UIHostBusyError extends Error {
  constructor() {
    super(
      "UI host resource is busy until its active session finishes cleanup.",
    );
    this.name = "UIHostBusyError";
  }
}

export class UIHostDisposedError extends Error {
  constructor() {
    super("UI host binding is disposed.");
    this.name = "UIHostDisposedError";
  }
}

/** Configure a frontend inside shared UI; callers consume only UIHost. */
export function createUIHost(
  adapter: UIAdapter,
  options: UIHostOptions = {},
): UIHost {
  const lifetime = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([lifetime.signal, options.signal])
    : lifetime.signal;
  let owned: UISession | undefined;
  let disposal: Promise<void> | undefined;

  return {
    open(view: UIView, request: UIOpenOptions) {
      if (disposal) throw new UIHostDisposedError();
      if (leases.has(adapter)) throw new UIHostBusyError();
      const sessionSignal = request.signal
        ? AbortSignal.any([signal, request.signal])
        : signal;
      const normalize = (result: UIHostOutcome): UIHostOutcome =>
        result.status === "aborted" && !("error" in result)
          ? { status: "aborted", error: sessionSignal.reason }
          : result;
      const { onEvent, onClosed } = request;
      let session!: UISession;
      const raw = createUISession(view, {
        ...request,
        adapter,
        signal: sessionSignal,
        onEvent: (event) => onEvent(event, session),
        onClosed: onClosed
          ? (result) => onClosed(normalize(result))
          : undefined,
      });
      session = { ...raw, closed: raw.closed.then(normalize) };
      owned = session;
      leases.set(adapter, session);
      void session.closed.then(() => {
        if (leases.get(adapter) === session) leases.delete(adapter);
        if (owned === session) owned = undefined;
      });
      return session;
    },
    dispose() {
      if (disposal) return disposal;
      let resolve!: () => void;
      disposal = new Promise<void>((done) => {
        resolve = done;
      });
      const active = owned;
      lifetime.abort(new DOMException("UI host disposed.", "AbortError"));
      void Promise.resolve(active?.closed).then(() => resolve());
      return disposal;
    },
  };
}
