import type { RuntimeCapabilities } from "./runtime/index.ts";
import {
  type AgentStatus,
  isTerminalStatus,
  isWorkingStatus,
  type SessionState,
} from "./state.ts";

/** Only facts used by policy, not a second state store or an operation gateway. */
export interface ManagedPolicyRecord {
  snapshot: {
    status: AgentStatus;
    sessionState?: SessionState;
    keepAlive?: boolean;
  };
  execution: { finished: boolean; dispatched: boolean };
  session?: { connected: boolean; capabilities: RuntimeCapabilities };
  releaseRequested?: boolean;
  terminating?: unknown;
}

/** Ordered blockers preserve public error priority; status is not completion. */
export function resumeBlocker(record: ManagedPolicyRecord): string | undefined {
  if (record.releaseRequested || record.snapshot.sessionState === "closed")
    return "Subagent runtime is closed/released; no connected worker remains.";
  if (!record.execution.finished)
    return "Only a finished managed task can be resumed.";
  if (record.terminating)
    return "Worker cleanup is still in progress; resume is unavailable.";
  if (
    !record.session?.connected ||
    !record.session.capabilities.retainedSession
  )
    return "Resume requires a retained, connected runtime; no automatic restart.";
  if (record.snapshot.sessionState !== "idle")
    return "Resume requires an idle session; wait for native/user interaction to settle.";
  return undefined;
}

export function steerBlocker(record: ManagedPolicyRecord): string | undefined {
  if (
    record.snapshot.status !== "running" ||
    record.snapshot.sessionState !== "running" ||
    record.execution.finished ||
    !record.execution.dispatched ||
    !record.session?.connected ||
    record.releaseRequested ||
    record.terminating
  )
    return "Only a connected running managed task can be steered.";
  if (!record.session.capabilities.steer)
    return "This runtime does not support steering.";
  return undefined;
}

/** New rounds are unfinished: never reuse resume's finished-round prerequisite. */
export function dispatchBlocker(
  record: ManagedPolicyRecord,
  phase: "startup" | "resume",
): "disconnected" | "busy" | undefined {
  if (
    phase === "startup" &&
    (!record.session?.connected ||
      record.snapshot.sessionState === "disconnected" ||
      record.snapshot.sessionState === "closed")
  )
    return "disconnected";
  if (
    !record.session?.connected ||
    (phase === "resume" && (record.releaseRequested || record.terminating)) ||
    record.snapshot.sessionState !== "idle"
  )
    return "busy";
  return undefined;
}

export function nativeViewBlocker(
  record: ManagedPolicyRecord,
  sessionClosed: boolean,
): string | undefined {
  if (
    record.releaseRequested ||
    record.snapshot.sessionState === "closed" ||
    record.terminating ||
    sessionClosed
  )
    return "Subagent runtime is closed/released.";
  if (!record.session) return "Subagent terminal is not ready yet.";
  if (
    !record.execution.finished &&
    !record.session.capabilities.concurrentNativeInput
  )
    return "Native attachment requires no managed task; wait for this round to finish.";
  return undefined;
}

export function canAutoRelease(
  record: ManagedPolicyRecord,
  disposed: boolean,
): boolean {
  return (
    !disposed &&
    !record.releaseRequested &&
    !record.snapshot.keepAlive &&
    record.execution.finished &&
    record.snapshot.sessionState !== "closed" &&
    record.snapshot.sessionState !== "interactive"
  );
}

export interface DisplayPolicySnapshot {
  status: AgentStatus;
  sessionState?: SessionState;
  capabilities?: RuntimeCapabilities;
  terminalId?: string;
}

/** Display activity is not permission to dispatch, resume or attach. */
export function isDisplayActive(agent: DisplayPolicySnapshot): boolean {
  return isWorkingStatus(agent.status) || agent.sessionState === "interactive";
}

export function hasDisplayError(agent: DisplayPolicySnapshot): boolean {
  return (
    agent.status === "error" ||
    agent.status === "disconnected" ||
    agent.sessionState === "disconnected"
  );
}

/** Conservative hint: snapshots do not carry finished/ownership/connection facts. */
export function nativeViewHint(agent: DisplayPolicySnapshot): boolean {
  if (agent.sessionState === "closed") return false;
  if (
    !isTerminalStatus(agent.status) &&
    agent.capabilities?.concurrentNativeInput !== true
  )
    return false;
  if (agent.terminalId) return true;
  return (
    agent.capabilities?.retainedSession === true &&
    (agent.sessionState === "running" ||
      agent.sessionState === "idle" ||
      agent.sessionState === "interactive") &&
    agent.status !== "queued" &&
    agent.status !== "starting" &&
    agent.status !== "disconnected" &&
    (agent.status !== "error" || agent.sessionState === "idle")
  );
}
