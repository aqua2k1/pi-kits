/** Managed lifecycle and backend state are independent axes. */
export type AgentStatus =
  | "queued"
  | "starting"
  | "running"
  | "stopping"
  | "disconnected"
  | "completed"
  | "stopped"
  | "error";

export type BackendSessionState = "idle" | "running" | "interactive";
export type SessionState = BackendSessionState | "disconnected" | "closed";

export function isBackendSessionState(
  value: unknown,
): value is BackendSessionState {
  return value === "idle" || value === "running" || value === "interactive";
}

export function isTerminalStatus(status: AgentStatus): boolean {
  return status === "completed" || status === "stopped" || status === "error";
}

export function isWorkingStatus(status: AgentStatus): boolean {
  return status === "starting" || status === "running" || status === "stopping";
}

/** Pi preflight also observes non-agent operations via the host idle flag. */
export function nativeInputPending(
  state: BackendSessionState,
  hostIdle: boolean,
): boolean {
  return state === "interactive" || !hostIdle;
}
