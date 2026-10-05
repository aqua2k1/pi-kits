import type { WorkerExtensionSource } from "@pi-kits/config";
import type { AgentDefinition } from "../agents.ts";
import type { MuxAdapter, TerminalHandle } from "../mux/index.ts";
import type { ParentSessionSnapshot } from "./pi/clone.ts";

/** Runtime names are resolved by the registry, not the agent parser. */
export type RuntimeId = string;

export interface RuntimeCapabilities {
  /** Can create an independent session from a native Pi branch snapshot.
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
  model?: string;
  thinking?: string;
  agent?: AgentDefinition;
  runtimeConfig?: Record<string, unknown>;
  /** Opaque host context; only the selected runtime may consume it at spawn. */
  context?: unknown;
  parentSession?: ParentSessionSnapshot;
  extensionAllowlist?: readonly WorkerExtensionSource[];
  executable?: string;
  workerPath?: string;
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

/** Normalized events; runtime adapters never expose their native transport. */
export type RuntimeEvent = Record<string, unknown> & { type: string };

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
