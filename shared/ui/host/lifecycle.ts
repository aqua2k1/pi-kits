export type UIFailureStatus = "aborted" | "error";

/** Legacy interactions without a host outcome: classify caller-owned cancellation. */
export function classifyUIFailure(signal?: AbortSignal): UIFailureStatus {
  return signal?.aborted ? "aborted" : "error";
}
