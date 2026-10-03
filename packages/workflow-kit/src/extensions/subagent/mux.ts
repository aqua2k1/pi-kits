export interface TerminalHandle {
  id: string;
}

/** Startup failed, but the adapter still owns resources requiring cleanup. */
export class TerminalStartError extends Error {
  constructor(
    public readonly terminal: TerminalHandle,
    cause: unknown,
  ) {
    super("Mux terminal startup failed; cleanup required.", { cause });
    this.name = "TerminalStartError";
  }
}

export interface ViewHandle {
  id: string;
}

export interface StartOptions {
  agentId: string;
  cwd: string;
  /** Complete command, including the executable (e.g. pi -e worker.ts). */
  argv: string[];
  env: Record<string, string>;
}

export interface OpenViewOptions {
  terminal: TerminalHandle;
  direction: "right" | "down";
}

/** Handles are opaque and scoped to the adapter instance that created them. */
export interface MuxAdapter {
  check_env(): boolean;
  start(options: StartOptions): Promise<TerminalHandle>;
  inspect(terminal: TerminalHandle): Promise<{ alive: boolean }>;
  destroy(terminal: TerminalHandle): Promise<void>;
  /** Writable/control attachment only; closing it does not stop the worker. */
  open_view(options: OpenViewOptions): Promise<ViewHandle>;
  focus_view(view: ViewHandle): Promise<void>;
  close_view(view: ViewHandle): Promise<void>;
}
