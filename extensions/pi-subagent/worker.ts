import { randomUUID } from "node:crypto";
import { createConnection, type Socket } from "node:net";
import type {
  ExtensionAPI,
  ExtensionContext,
  MessageEndEvent,
} from "@earendil-works/pi-coding-agent";
import { truncateUtf8 } from "./util.ts";

export type WorkerSessionState = "idle" | "running" | "interactive";
export const MAX_COMMAND_BYTES = 64 * 1024;
export const MAX_RESULT_BYTES = 64 * 1024;
export const WORKER_MARKER = "PI_KITS_SUBAGENT_WORKER";
const MAX_ACTIVITY_BYTES = 4096;

export function isBackendSessionState(v: unknown): v is WorkerSessionState {
  return v === "idle" || v === "running" || v === "interactive";
}

export interface SessionUpdate {
  type: "session_update";
  interactionId: string;
  sequence: number;
  response: string;
  outcome: "completed" | "aborted" | "error";
  truncated?: boolean;
  error?: string;
}

export type WorkerCommand =
  | { type: "task"; prompt: string; round?: number }
  | { type: "steer"; message: string; round?: number }
  | { type: "cancel"; round?: number };

export type WorkerEvent = (
  | (SessionUpdate & { id: string; round?: never })
  | {
      type: "session_state";
      id: string;
      state: WorkerSessionState;
      activity?: string;
    }
  | {
      type: "stats";
      id: string;
      turnCount: number;
      toolUses: number;
      totalTokens: number;
      contextPercent?: number;
      compactionCount: number;
    }
  | { type: "ready"; id: string; token: string; sessionPath?: string }
  | { type: "model_select"; id: string }
  | { type: "started"; id: string }
  | { type: "activity"; id: string; event: string; toolName?: string }
  | {
      type: "completed";
      id: string;
      result: string;
      error?: string;
      canceled?: boolean;
      truncated?: boolean;
      sessionPath?: string;
    }
) & {
  round?: number;
  model?: string;
  sessionPath?: string;
};

export interface WorkerConfig {
  host: "127.0.0.1";
  port: number;
  token: string;
  id: string;
}

export interface WorkerDependencies {
  connect(config: WorkerConfig): Socket;
  terminate?(): void;
}

export function isSubagentWorker(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env[WORKER_MARKER] === "1";
}

export function readWorkerConfig(
  env: NodeJS.ProcessEnv = process.env,
): WorkerConfig | undefined {
  if (!isSubagentWorker(env)) return undefined;
  const match = /^127\.0\.0\.1:([0-9]{1,5})$/.exec(
    env.PI_KITS_SUBAGENT_ENDPOINT ?? "",
  );
  const port = Number(match?.[1]);
  const token = env.PI_KITS_SUBAGENT_TOKEN;
  const id = env.PI_KITS_SUBAGENT_ID;
  if (
    !match ||
    port < 1 ||
    port > 65535 ||
    !token ||
    token.length > 4096 ||
    !id ||
    id.length > 256
  ) {
    throw new Error("Invalid subagent worker environment");
  }
  return { host: "127.0.0.1", port, token, id };
}

export function parseWorkerCommand(value: unknown): WorkerCommand {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected a worker command object");
  }
  const cmd = value as Record<string, unknown>;
  if (
    cmd.round !== undefined &&
    (!Number.isSafeInteger(cmd.round) || (cmd.round as number) < 1)
  ) {
    throw new Error("Invalid worker round");
  }
  const round = cmd.round === undefined ? {} : { round: cmd.round as number };
  if (cmd.type === "cancel") return { type: "cancel", ...round };
  if (
    cmd.type === "task" &&
    typeof cmd.prompt === "string" &&
    cmd.prompt.trim()
  ) {
    return { type: "task", prompt: cmd.prompt, ...round };
  }
  if (
    cmd.type === "steer" &&
    typeof cmd.message === "string" &&
    cmd.message.trim()
  ) {
    return { type: "steer", message: cmd.message, ...round };
  }
  throw new Error("Invalid worker command");
}

function messageText(msg: MessageEndEvent["message"]): string {
  if (!("content" in msg)) return "";
  return typeof msg.content === "string"
    ? msg.content
    : msg.content
        .filter((p) => p.type === "text")
        .map((p) => p.text)
        .join("\n");
}

export function registerWorkerBridge(
  pi: ExtensionAPI,
  config: WorkerConfig,
  deps: WorkerDependencies = {
    connect: ({ host, port }) => createConnection({ host, port }),
  },
): void {
  let socket: Socket | undefined;
  let ctx: ExtensionContext | undefined;
  let state: WorkerSessionState = "idle";
  let activeRound: number | undefined;
  let canceling = false;
  let result = "";
  let truncated = false;
  let error: string | undefined;
  let aborted = false;
  let turnCount = 0;
  let toolUses = 0;
  let totalTokens = 0;
  let compactionCount = 0;
  let native: SessionUpdate | undefined;
  let nativeSeq = 0;

  const modelMeta = (m = ctx?.model) =>
    m ? { model: `${m.provider}/${m.id}` } : {};

  const shutdown = () => {
    const prev = socket;
    socket = undefined;
    prev?.destroy();
    activeRound = undefined;
    try {
      ctx?.abort();
    } finally {
      try {
        ctx?.shutdown();
      } finally {
        if (deps.terminate) deps.terminate();
        else process.kill(process.pid, "SIGTERM");
      }
    }
  };

  const send = (ev: WorkerEvent) => {
    if (!socket || socket.destroyed) return;
    if (
      activeRound !== undefined &&
      ev.type !== "ready" &&
      ev.type !== "session_update"
    ) {
      ev = { round: activeRound, ...ev };
    }
    if (
      ev.type === "ready" ||
      ev.type === "session_state" ||
      ev.type === "stats"
    ) {
      ev = { ...modelMeta(), ...ev };
    }
    try {
      socket.write(`${JSON.stringify(ev)}\n`);
    } catch {
      shutdown();
    }
  };

  const reportState = (next: WorkerSessionState, activity?: string) => {
    state = next;
    send({
      type: "session_state",
      id: config.id,
      state,
      ...(activity
        ? { activity: truncateUtf8(activity, MAX_ACTIVITY_BYTES).text }
        : {}),
    });
  };

  const completeTask = () => {
    if (activeRound === undefined || !ctx) return;
    reportState("idle");
    send({
      type: "completed",
      id: config.id,
      result,
      ...(error ? { error } : {}),
      ...(canceling || aborted ? { canceled: true } : {}),
      ...(truncated ? { truncated: true } : {}),
      sessionPath: ctx.sessionManager.getSessionFile(),
    });
    activeRound = undefined;
    canceling = false;
  };

  const receive = (cmd: WorkerCommand) => {
    if (!ctx) return;
    if (cmd.type === "cancel") {
      if (
        activeRound !== undefined &&
        (cmd.round === undefined || cmd.round === activeRound)
      ) {
        canceling = true;
        ctx.abort();
      }
      return;
    }
    if (cmd.type === "steer") {
      if (
        activeRound !== undefined &&
        !canceling &&
        (cmd.round === undefined || cmd.round === activeRound)
      ) {
        pi.sendUserMessage(cmd.message, {
          deliverAs: "steer",
          expandPromptTemplates: false,
        });
      }
      return;
    }
    if (activeRound === undefined) {
      if (state === "interactive" || !ctx.isIdle()) {
        send({
          type: "completed",
          id: config.id,
          result: "",
          ...(cmd.round !== undefined ? { round: cmd.round } : {}),
          error: "Subagent is busy with user interaction; wait until idle.",
          sessionPath: ctx.sessionManager.getSessionFile(),
        });
        return;
      }
      activeRound = cmd.round ?? 1;
      canceling = false;
      result = "";
      truncated = false;
      error = undefined;
      aborted = false;
      turnCount = 0;
      toolUses = 0;
      totalTokens = 0;
      compactionCount = 0;
      reportState("running");
    }
    try {
      pi.sendUserMessage(cmd.prompt, {
        deliverAs: "followUp",
        expandPromptTemplates: false,
      });
    } catch (cause) {
      error = truncateUtf8(String(cause), MAX_ACTIVITY_BYTES).text;
      completeTask();
    }
  };

  pi.on("session_start", (_ev, c) => {
    socket?.destroy();
    ctx = c;
    state = "idle";
    activeRound = undefined;
    const conn = deps.connect(config);
    socket = conn;
    conn.setNoDelay(true);
    conn.unref();
    let buf = "";
    conn.on("connect", () => {
      if (socket !== conn) return;
      send({
        type: "ready",
        id: config.id,
        token: config.token,
        sessionPath: c.sessionManager.getSessionFile(),
      });
      reportState("idle");
    });
    conn.on("data", (chunk: Buffer | string) => {
      if (socket !== conn) return;
      buf += chunk.toString("utf8");
      if (Buffer.byteLength(buf) > MAX_COMMAND_BYTES * 2) return shutdown();
      for (let nl = buf.indexOf("\n"); nl !== -1; nl = buf.indexOf("\n")) {
        const line = buf.slice(0, nl).replace(/\r$/, "");
        buf = buf.slice(nl + 1);
        try {
          receive(parseWorkerCommand(JSON.parse(line)));
        } catch {
          return shutdown();
        }
      }
    });
    conn.on("error", () => {
      if (socket === conn) shutdown();
    });
    conn.on("close", () => {
      if (socket === conn) shutdown();
    });
  });

  pi.on("model_select", (ev, c) => {
    ctx = c;
    send({ type: "model_select", id: config.id, ...modelMeta(ev.model) });
  });

  const onTurnStart = (c: ExtensionContext) => {
    ctx = c;
    if (activeRound === undefined) {
      reportState("interactive", "Thinking…");
      native ??= {
        type: "session_update",
        interactionId: randomUUID(),
        sequence: ++nativeSeq,
        response: "",
        outcome: "completed",
      };
    } else if (canceling) c.abort();
    else send({ type: "started", id: config.id });
  };
  pi.on("before_agent_start", (_e, c) => onTurnStart(c));
  pi.on("agent_start", (_e, c) => onTurnStart(c));

  pi.on("tool_execution_start", (ev, c) => {
    ctx = c;
    if (activeRound === undefined) {
      if (state === "interactive") reportState("interactive", ev.toolName);
    } else {
      toolUses += 1;
      send({
        type: "activity",
        id: config.id,
        event: "tool_execution_start",
        toolName: ev.toolName,
      });
    }
  });

  pi.on("tool_execution_end", (ev, c) => {
    ctx = c;
    if (activeRound === undefined) {
      if (state === "interactive") reportState("interactive", "Thinking…");
    } else
      send({
        type: "activity",
        id: config.id,
        event: "tool_execution_end",
        toolName: ev.toolName,
      });
  });

  pi.on("session_compact", (_e, c) => {
    ctx = c;
    if (activeRound !== undefined) compactionCount += 1;
  });

  pi.on("message_end", (ev, c) => {
    ctx = c;
    if (ev.message.role !== "assistant") return;
    const text = truncateUtf8(messageText(ev.message), MAX_RESULT_BYTES);
    const err =
      ev.message.stopReason === "error"
        ? truncateUtf8(
            ev.message.errorMessage || "Pi assistant failed",
            MAX_ACTIVITY_BYTES,
          ).text
        : undefined;
    if (activeRound === undefined) {
      if (native) {
        native.response = text.text;
        native.truncated = text.truncated || undefined;
        native.outcome =
          ev.message.stopReason === "error"
            ? "error"
            : ev.message.stopReason === "aborted"
              ? "aborted"
              : "completed";
        native.error = err;
      }
      return;
    }
    turnCount += 1;
    const u = ev.message.usage;
    totalTokens += (u?.input ?? 0) + (u?.output ?? 0) + (u?.cacheWrite ?? 0);
    const pct = c.getContextUsage?.()?.percent;
    send({
      type: "stats",
      id: config.id,
      turnCount,
      toolUses,
      totalTokens,
      compactionCount,
      ...(typeof pct === "number" && Number.isFinite(pct)
        ? { contextPercent: pct }
        : {}),
    });
    result = text.text;
    truncated = text.truncated;
    error = err;
    aborted = ev.message.stopReason === "aborted";
  });

  pi.on("agent_before_settle", (ev, c) => {
    ctx = c;
    if (activeRound === undefined && native) {
      native.outcome = ev.outcome;
      native.error =
        ev.outcome === "error"
          ? native.error || "Pi assistant failed"
          : undefined;
    }
  });

  pi.on("agent_settled", (_e, c) => {
    ctx = c;
    const settled = native;
    native = undefined;
    if (activeRound !== undefined) completeTask();
    else {
      reportState("idle");
      if (settled) send({ ...settled, id: config.id });
    }
  });

  pi.on("session_shutdown", () => {
    socket?.destroy();
    socket = undefined;
    activeRound = undefined;
    native = undefined;
    ctx = undefined;
  });
}

export default function workerExtension(pi: ExtensionAPI): void {
  const config = readWorkerConfig();
  if (config) registerWorkerBridge(pi, config);
}
