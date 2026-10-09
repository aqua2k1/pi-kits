import type { UIView } from "../protocol/index.ts";
import type {
  UICloseResult,
  UISession,
  UISessionOptions,
} from "../session/index.ts";

export type UIOpenOptions = Omit<UISessionOptions, "adapter">;
export type UIHostOutcome = UICloseResult;

/** Business-facing interface: no concrete frontend or Pi context. */
export interface UIHost {
  open(view: UIView, options: UIOpenOptions): UISession;
  /** Abort owned work and wait for cleanup; safe to call repeatedly. */
  dispose(): Promise<void>;
}

export interface UIHostOptions {
  /** Lifetime of the current host binding, not a cached operation context. */
  signal?: AbortSignal;
}
