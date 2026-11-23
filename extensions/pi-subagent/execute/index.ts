import { randomUUID } from "node:crypto";

export interface TerminalHandle {
  id: string;
}

export class ExecutorError extends Error {
  constructor(
    public readonly code: string,
    detail?: string,
    options?: ErrorOptions,
  ) {
    super(detail ? `${code}: ${detail}` : code, options);
    this.name = "ExecutorError";
  }
}

export interface ViewHandle {
  id: string;
}

export interface StartOptions {
  agentId: string;
  /** Configured agent type; omitted for anonymous sessions. */
  agentType?: string;
  cwd: string;
  /** Complete command, including the executable (e.g. pi -e worker.ts). */
  argv: string[];
  env: Record<string, string>;
}

/** Terminal executors own their native view placement (tabs vs split panes). */
export interface OpenViewOptions {
  terminal: TerminalHandle;
}

export interface ExecutorFactoryOptions {
  warn?: (message: string) => void;
  env?: NodeJS.ProcessEnv;
}

export type ExecutorId = "herdr-core" | "subprocess";

/** Handles are opaque and scoped to the executor instance that created them. */
export interface Executor {
  readonly id: ExecutorId;
  readonly supportsView: boolean;
  check_env(): boolean;
  start(options: StartOptions): Promise<TerminalHandle>;
  inspect(terminal: TerminalHandle): Promise<{ alive: boolean }>;
  destroy(terminal: TerminalHandle): Promise<void>;
  /** Writable/control attachment only; closing it does not stop the worker. */
  open_view?(options: OpenViewOptions): Promise<ViewHandle>;
  /** False for closed, moved, or replaced attachments; never follows them. */
  inspect_view?(view: ViewHandle): Promise<{ alive: boolean }>;
  focus_view?(view: ViewHandle): Promise<void>;
  /** Idempotent for owned views retired by close_view or terminal destroy. */
  close_view?(view: ViewHandle): Promise<void>;
}

export function buildChildEnv(
  baseEnv: NodeJS.ProcessEnv,
  overrides: Record<string, string>,
  omitKeys: string[] = [],
): Record<string, string> {
  const excluded = new Set(omitKeys);
  return Object.fromEntries(
    Object.entries({ ...baseEnv, ...overrides }).filter(
      (entry): entry is [string, string] =>
        !excluded.has(entry[0]) && entry[1] !== undefined,
    ),
  );
}

export function createHandleTable<T>(unownedCode: string) {
  const entries = new Map<string, T>();
  return {
    create(value: T): { id: string } {
      const handle = { id: randomUUID() };
      entries.set(handle.id, value);
      return handle;
    },
    get(handle: { id: string }): T | undefined {
      return entries.get(handle.id);
    },
    owned(handle: { id: string }): T {
      const found = entries.get(handle.id);
      if (!found) throw new ExecutorError(unownedCode);
      return found;
    },
    delete(handle: { id: string }): void {
      entries.delete(handle.id);
    },
  };
}
