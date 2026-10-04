/** Shared wire contract, not Pi capability or source-format policy. */
export const MAX_COMMAND_BYTES = 64 * 1024;
export const MAX_RESULT_BYTES = 64 * 1024;
export const MAX_PENDING_COMMANDS = 32;

const SESSION_STATES = ["idle", "running", "interactive"] as const;
export type WorkerSessionState = (typeof SESSION_STATES)[number];

export function isWorkerSessionState(
  value: unknown,
): value is WorkerSessionState {
  return SESSION_STATES.some((state) => state === value);
}
