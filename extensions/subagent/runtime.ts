import type { WorkerExtensionSource } from "@pi-kits/config";
import type { AgentDefinition } from "./agents.ts";
import type { ParentSessionSnapshot } from "./clone.ts";
import type { MuxAdapter, TerminalHandle } from "./mux.ts";

/** Runtime names are resolved by the registry, not the agent parser. */
export type RuntimeId = string;

export interface RuntimeCapabilities {
  nativeClone: boolean;
  steer: boolean;
  retainedSession: boolean;
  /** Whether writable native UI may coexist with managed submissions. */
  concurrentNativeInput: boolean;
}

export interface RuntimeOptions {
  id: string;
  cwd: string;
  model?: string;
  thinking?: string;
  agent?: AgentDefinition;
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

export interface AgentRuntime {
  readonly id: RuntimeId;
  readonly displayName?: string;
  readonly capabilities: RuntimeCapabilities;
  validate(options: RuntimeOptions): void;
  create(options: RuntimeOptions, host: RuntimeHost): RuntimeSession;
}
