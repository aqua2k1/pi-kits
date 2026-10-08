import type { UIEvent, UIView } from "../protocol/index.ts";

export type UICloseStatus = "completed" | "dismissed" | "aborted" | "error";

/** Process-local lifecycle result; not a wire message or a business result. */
export interface UICloseResult {
  status: UICloseStatus;
  error?: unknown;
}

export interface UIMount {
  /** Restore the host and release all adapter resources. Called exactly once. */
  dispose(): void | Promise<void>;
}

/** Adapter-facing capabilities. No business control or Pi context is exposed. */
export interface UIPort {
  /** The current immutable complete snapshot. */
  getSnapshot(): UIView;
  subscribe(listener: () => void): () => void;
  dispatch(event: unknown): Promise<void>;
  /** Aborted on any close; adapters must stop pending mount/input work. */
  readonly signal: AbortSignal;
}

export interface UIAdapter {
  /** Must settle when signal is aborted, releasing partial mounts on failure. */
  mount(port: UIPort): UIMount | Promise<UIMount>;
}

export interface UISession extends UIPort {
  /** Replace the full snapshot with the same view ID and a higher revision. */
  publish(view: UIView): void;
  /** Business controller decides whether dismissal means cancelling its use case. */
  close(status?: "completed" | "dismissed"): void;
  /** Resolves after mount settlement, adapter disposal and closed callback. */
  readonly closed: Promise<UICloseResult>;
}

export interface UISessionOptions {
  adapter: UIAdapter;
  onEvent(event: UIEvent, session: UISession): void | Promise<void>;
  signal?: AbortSignal;
  /** Adapter mounted, not a paint/client acknowledgment. */
  onOpen?(): void | Promise<void>;
  onClosed?(result: UICloseResult): void | Promise<void>;
}
