/** Shared wire contract, not Pi capability or source-format policy. */
export const MAX_COMMAND_BYTES = 64 * 1024;
export const MAX_RESULT_BYTES = 64 * 1024;
export const MAX_PENDING_COMMANDS = 32;

// Compatibility names for Pi wire consumers; the state contract is runtime-neutral.
export {
  type BackendSessionState as WorkerSessionState,
  isBackendSessionState as isWorkerSessionState,
} from "../../state.ts";
