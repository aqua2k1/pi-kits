export interface Measurement {
  readonly requestStartedAt?: number;
  readonly firstTextAt?: number;
  readonly messageStarted: boolean;
}

interface ResponseUsage {
  readonly durationMs?: number;
  readonly usage?: { readonly output: number };
  readonly stopReason: string;
}

interface Metrics {
  readonly ttftMs?: number;
  readonly tps?: number;
}

function validDuration(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value > 0;
}

export function createMeasurement(): Measurement {
  return { messageStarted: false };
}

export function startRequest(state: Measurement, at: number): Measurement {
  // Provider hooks have no request id. An overlapping request cannot be
  // safely associated with an already streaming assistant message.
  return {
    messageStarted: state.messageStarted,
    requestStartedAt: state.messageStarted ? undefined : at,
  };
}

export function startMessage(state: Measurement): Measurement {
  return {
    requestStartedAt: state.requestStartedAt,
    messageStarted: true,
  };
}

export function recordText(
  state: Measurement,
  delta: string,
  at: number,
): Measurement {
  if (
    !state.messageStarted ||
    state.requestStartedAt === undefined ||
    state.firstTextAt !== undefined ||
    delta.length === 0
  ) {
    return state;
  }
  return { ...state, firstTextAt: at };
}

function calculateTtft(state: Measurement): number | undefined {
  if (state.requestStartedAt === undefined || state.firstTextAt === undefined) {
    return undefined;
  }
  const ttftMs = state.firstTextAt - state.requestStartedAt;
  return Number.isFinite(ttftMs) && ttftMs >= 0 ? ttftMs : undefined;
}

function calculateTps(
  state: Measurement,
  response: ResponseUsage,
  endedAt: number,
): number | undefined {
  // Older Pi runtimes omit response duration. In that case use the same
  // request's observed boundaries, never the entire user/tool round.
  const durationMs = validDuration(response.durationMs)
    ? response.durationMs
    : state.requestStartedAt === undefined
      ? undefined
      : endedAt - state.requestStartedAt;
  const output = response.usage?.output;
  const successful = ["stop", "length", "toolUse"].includes(
    response.stopReason,
  );
  const tps =
    successful &&
    validDuration(durationMs) &&
    output !== undefined &&
    Number.isFinite(output) &&
    output > 0
      ? output / (durationMs / 1000)
      : undefined;

  return tps !== undefined && Number.isFinite(tps) ? tps : undefined;
}

export function calculateMetrics(
  state: Measurement,
  response: ResponseUsage,
  endedAt: number,
): Metrics {
  return {
    ttftMs: calculateTtft(state),
    tps: calculateTps(state, response, endedAt),
  };
}
