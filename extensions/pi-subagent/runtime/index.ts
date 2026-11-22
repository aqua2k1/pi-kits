import type { AgentDefinition } from "../agents.ts";
import type { MuxAdapter, TerminalHandle } from "../mux/index.ts";
import type { BackendSessionState } from "../state.ts";

/** Shared wire limits enforced across manager and runtime sessions. */
export const MAX_COMMAND_BYTES = 64 * 1024;
export const MAX_RESULT_BYTES = 64 * 1024;

/** A task was rejected before dispatch; no native/user work was touched. */
export class RuntimeTaskRejectedError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RuntimeTaskRejectedError";
  }
}

/** Runtime names are resolved by the manager, not the agent parser. */
export type RuntimeId = string;

export interface RuntimeCapabilities {
  /** Can create an independent session from a native parent branch snapshot.
   * This does not imply conversion of transcripts from other runtimes.
   */
  nativeClone: boolean;
  steer: boolean;
  retainedSession: boolean;
  /** Whether writable native UI may coexist with an active managed turn. */
  concurrentNativeInput: boolean;
}

export interface RuntimeOptions {
  id: string;
  cwd: string;
  /** Native session name fixed at creation; never updated for later rounds. */
  sessionName?: string;
  model?: string;
  thinking?: string;
  agent?: AgentDefinition;
  runtimeConfig?: Record<string, unknown>;
  /** Opaque host context; only the selected runtime may consume it at spawn. */
  context?: unknown;
  /** Opaque runtime-owned frozen parent context snapshot (e.g. Pi branch). */
  parentSession?: unknown;
  executable?: string;
  startupTimeoutMs?: number;
}

export type RuntimeCommand = (
  | {
      type: "task";
      prompt: string;
      /** Task-local parameters interpreted only by the selected runtime. */
      runtimeParams?: Record<string, unknown>;
      instructions?: { systemPrompt?: string; tools?: string[] };
    }
  | { type: "steer"; message: string }
  | { type: "cancel" }
) & { round?: number };

/** A settled native interaction, independent of managed task completion. */
export interface SessionUpdate {
  type: "session_update";
  interactionId: string;
  /** Monotonic interaction start order within this runtime session. */
  sequence: number;
  response: string;
  outcome: "completed" | "aborted" | "error";
  truncated?: boolean;
  error?: string;
}

export interface RuntimeEventMeta {
  id?: string;
  round?: number;
  threadId?: string;
  turnId?: string;
  runtimeSessionId?: string;
  sessionPath?: string;
  model?: string;
  modelName?: string;
  provider?: string;
  thinkingLevel?: string | null;
}

/** Normalized events; runtime adapters never expose their native transport. */
export type RuntimeEvent =
  | (SessionUpdate & {
      id?: string;
      round?: never;
      threadId?: string;
      runtimeSessionId?: string;
    })
  | (RuntimeEventMeta & { type: "disconnected"; error?: string })
  | (RuntimeEventMeta & { type: "model_select" })
  | (RuntimeEventMeta & {
      type: "session_state";
      state: BackendSessionState;
      activity?: string;
    })
  | (RuntimeEventMeta & { type: "started" })
  | (RuntimeEventMeta & {
      type: "stats";
      turnCount?: number;
      toolUses?: number;
      totalTokens?: number;
      contextPercent?: number;
      compactionCount?: number;
      usage?: unknown;
    })
  | (RuntimeEventMeta & {
      type: "activity";
      event?: string;
      toolName?: string;
      toolCallId?: string;
      parentToolCallId?: string;
      role?: string;
      text?: string;
      isError?: boolean;
      truncated?: boolean;
    })
  | (RuntimeEventMeta & {
      type: "completed";
      result: string;
      error?: string;
      canceled?: boolean;
      truncated?: boolean;
      resultSequence?: number;
    })
  | (RuntimeEventMeta & { type: "error"; error: string })
  | (RuntimeEventMeta & {
      type: "blocked";
      requestMethod?: string;
      error?: string;
    });

export interface RuntimeHost {
  mux: MuxAdapter;
  emit(event: RuntimeEvent): void;
}

/** Owns execution resources, including optional native UI terminals. */
export interface RuntimeSession {
  readonly capabilities: RuntimeCapabilities;
  readonly connected: boolean;
  readonly terminal: TerminalHandle | undefined;
  start(): Promise<void>;
  send(command: RuntimeCommand): void | Promise<void>;
  inspect(): Promise<boolean>;
  /** Creates or returns a native UI attachment, not the execution backend. */
  attachment(): Promise<TerminalHandle>;
  close(): Promise<void>;
}

/** Runtime-owned partition of call options into session and per-round settings. */
export interface RuntimeCallConfig {
  runtimeConfig: Record<string, unknown>;
  runtimeParams: Record<string, unknown>;
}

export interface AgentRuntime {
  readonly id: RuntimeId;
  readonly displayName?: string;
  readonly capabilities: RuntimeCapabilities;
  /** Pure parsers: no processes, transports or lifecycle registration. */
  parseConfig?(config: Record<string, unknown>): Record<string, unknown>;
  parseCallConfig?(
    config: Record<string, unknown>,
    sessionConfig: Record<string, unknown>,
    phase: "spawn" | "resume",
  ): RuntimeCallConfig;
  parseTask?(command: RuntimeCommand, options: RuntimeOptions): RuntimeCommand;
  /** Synchronously freeze runtime-owned host inputs before queueing. */
  prepareSpawn?(options: RuntimeOptions): RuntimeOptions;
  validate(options: RuntimeOptions): void;
  create(options: RuntimeOptions, host: RuntimeHost): RuntimeSession;
}
