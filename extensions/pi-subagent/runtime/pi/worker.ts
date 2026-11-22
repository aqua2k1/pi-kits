import { randomUUID } from "node:crypto";
import { createConnection, type Socket } from "node:net";
import type {
  ExtensionAPI,
  ExtensionContext,
  MessageEndEvent,
} from "@earendil-works/pi-coding-agent";
import type { BackendSessionState } from "../../state.ts";
import { truncateUtf8 } from "../../util.ts";
import {
  MAX_COMMAND_BYTES,
  MAX_RESULT_BYTES,
  type SessionUpdate,
} from "../index.ts";

export type { BackendSessionState as WorkerSessionState } from "../../state.ts";
export { MAX_COMMAND_BYTES, MAX_RESULT_BYTES } from "../index.ts";

/** Manager listens on loopback; explicitly load this file with pi -e. */
export const WORKER_MARKER = "PI_KITS_SUBAGENT_WORKER";
export const MAX_PENDING_COMMANDS = 32;
const MAX_WRITE_BUFFER_BYTES = 1024 * 1024;
const MAX_ACTIVITY_BYTES = 4096;

/** Pi preflight also observes non-agent operations via the host idle flag. */
export function nativeInputPending(
  state: BackendSessionState,
  hostIdle: boolean,
): boolean {
  return state === "interactive" || !hostIdle;
}

/** LF-delimited JSON. Authentication is the manager's validation of ready.token.
 * A busy task joins the current batch as followUp; one completed covers the
 * entire batch, including steering, retries and automatic continuations.
 * Manager must await completed before assigning an independent task.
 */
export interface WorkerInstructions {
  /** Accepted for protocol compatibility; Pi prompts are configured at launch. */
  systemPrompt?: string;
  tools?: string[];
}

export type WorkerCommand = (
  | { type: "task"; prompt: string; instructions?: WorkerInstructions }
  | { type: "steer"; message: string }
  | { type: "cancel" }
) & { round?: number };

export type WorkerActivityName =
  | "agent_start"
  | "agent_end"
  | "message_end"
  | "tool_execution_start"
  | "tool_execution_end"
  | "control_rejected";

export type WorkerEvent = (
  | (SessionUpdate & { id: string; round?: never })
  | {
      type: "session_state";
      id: string;
      state: BackendSessionState;
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
  | {
      type: "activity";
      id: string;
      event: WorkerActivityName;
      toolName?: string;
      toolCallId?: string;
      parentToolCallId?: string;
      role?: string;
      text?: string;
      isError?: boolean;
      truncated?: boolean;
    }
  | {
      type: "completed";
      id: string;
      result: string;
      error?: string;
      canceled?: boolean;
      truncated?: boolean;
      sessionPath?: string;
    }
) & { round?: number; model?: string; modelName?: string };

export interface WorkerConfig {
  host: "127.0.0.1";
  port: number;
  token: string;
  id: string;
}

export interface WorkerDependencies {
  connect(config: WorkerConfig): Socket;
  /** Wake Pi's signal-based shutdown even when its TUI is idle. */
  terminate?(): void;
}

/** Parent coordination entry points should use this same exact marker check. */
export function isSubagentWorker(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env[WORKER_MARKER] === "1";
}

export function readWorkerConfig(
  env: NodeJS.ProcessEnv = process.env,
): WorkerConfig | undefined {
  if (!isSubagentWorker(env)) return undefined;
  const endpoint = /^127\.0\.0\.1:([0-9]{1,5})$/.exec(
    env.PI_KITS_SUBAGENT_ENDPOINT ?? "",
  );
  const port = Number(endpoint?.[1]);
  const token = env.PI_KITS_SUBAGENT_TOKEN;
  const id = env.PI_KITS_SUBAGENT_ID;
  if (
    !endpoint ||
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
  const command = value as Record<string, unknown>;
  if (
    command.round !== undefined &&
    (typeof command.round !== "number" ||
      !Number.isSafeInteger(command.round) ||
      command.round < 1)
  )
    throw new Error("Invalid worker round");
  const round =
    command.round === undefined ? {} : { round: command.round as number };
  if (command.type === "cancel") return { type: "cancel", ...round };
  if (
    command.type === "task" &&
    typeof command.prompt === "string" &&
    command.prompt.trim()
  ) {
    if (command.instructions === undefined) {
      return { type: "task", prompt: command.prompt, ...round };
    }
    const instructions =
      command.instructions as Partial<WorkerInstructions> | null;
    if (
      !instructions ||
      typeof instructions !== "object" ||
      Array.isArray(instructions) ||
      (instructions.systemPrompt !== undefined &&
        typeof instructions.systemPrompt !== "string") ||
      (instructions.tools !== undefined &&
        (!Array.isArray(instructions.tools) ||
          instructions.tools.some((name) => typeof name !== "string" || !name)))
    ) {
      throw new Error("Invalid worker instructions");
    }
    return {
      type: "task",
      prompt: command.prompt,
      ...round,
      instructions: {
        ...(instructions.systemPrompt !== undefined
          ? { systemPrompt: instructions.systemPrompt }
          : {}),
        ...(instructions.tools !== undefined
          ? { tools: instructions.tools }
          : {}),
      },
    };
  }
  if (
    command.type === "steer" &&
    typeof command.message === "string" &&
    command.message.trim()
  ) {
    return { type: "steer", message: command.message, ...round };
  }
  throw new Error("Invalid worker command");
}

/** Byte-bounded framing, including split UTF-8, CRLF and coalesced records.
 * Only LF splits records (U+2028/U+2029 are valid inside JSON strings).
 * Invalid JSON, empty records or oversized frames fail the connection closed.
 */
export function createWorkerJsonlReader(
  receive: (command: WorkerCommand) => void,
  maxBytes = MAX_COMMAND_BYTES,
): (chunk: Buffer) => void {
  let pending = Buffer.alloc(0);
  return (chunk) => {
    let offset = 0;
    while (offset < chunk.length) {
      const lf = chunk.indexOf(10, offset);
      const end = lf === -1 ? chunk.length : lf;
      const part = chunk.subarray(offset, end);
      if (pending.length + part.length > maxBytes) {
        throw new Error("Worker command frame too large");
      }
      pending = Buffer.concat([pending, part]);
      if (lf === -1) return;
      const line = new TextDecoder("utf-8", { fatal: true }).decode(pending);
      pending = Buffer.alloc(0);
      receive(parseWorkerCommand(JSON.parse(line)));
      offset = lf + 1;
    }
  };
}

function modelMetadata(model: ExtensionContext["model"]): {
  model?: string;
  modelName?: string;
} {
  return model
    ? { model: `${model.provider}/${model.id}`, modelName: model.name }
    : {};
}

function messageText(message: MessageEndEvent["message"]): string {
  if (!("content" in message)) return "";
  if (typeof message.content === "string") return message.content;
  return message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

interface ManagedTaskState {
  generation: number;
  preparing: boolean;
  active: boolean;
  round?: number;
  started: boolean;
  canceling: boolean;
  pendingCommands: number;
  startupQueue: WorkerCommand[];
  result: string;
  turnCount: number;
  toolUses: number;
  totalTokens: number;
  compactionCount: number;
  truncated: boolean;
  error?: string;
  aborted: boolean;
}

function createTaskState(generation: number): ManagedTaskState {
  return {
    generation,
    preparing: false,
    active: false,
    round: undefined,
    started: false,
    canceling: false,
    pendingCommands: 0,
    startupQueue: [],
    result: "",
    turnCount: 0,
    toolUses: 0,
    totalTokens: 0,
    compactionCount: 0,
    truncated: false,
    error: undefined,
    aborted: false,
  };
}

/** Testable factory; no resources are created until session_start in TUI mode.
 * Sockets are never used as Pi's stdin/stdout. Loss of the parent control
 * connection aborts work and shuts down the worker; there is no detach/reconnect.
 */
export function registerWorkerBridge(
  pi: ExtensionAPI,
  config: WorkerConfig,
  dependencies: WorkerDependencies = {
    connect: ({ host, port }) => createConnection({ host, port }),
  },
): void {
  const conn = {
    socket: undefined as Socket | undefined,
    connected: false,
    shuttingDown: false,
  };
  const session = {
    state: "idle" as BackendSessionState,
    activity: undefined as string | undefined,
    context: undefined as ExtensionContext | undefined,
    lastRound: 0,
  };
  let task = createTaskState(0);
  // Native state never participates in managed results, statistics or rounds.
  const native = {
    interaction: undefined as SessionUpdate | undefined,
    sequence: 0,
  };

  function resetTask(): void {
    task = createTaskState(task.generation + 1);
  }

  function disconnect(): void {
    conn.connected = false;
    const previous = conn.socket;
    conn.socket = undefined;
    previous?.destroy();
  }

  function loseParent(): void {
    if (conn.shuttingDown) return;
    conn.shuttingDown = true;
    const ctx = session.context;
    disconnect();
    resetTask();
    native.interaction = undefined;
    session.context = undefined;
    try {
      ctx?.abort();
    } finally {
      try {
        ctx?.shutdown();
      } finally {
        // ctx.shutdown only sets a flag in Pi's TUI; an idle worker may never
        // submit another input. SIGTERM invokes Pi's graceful shutdown now.
        if (dependencies.terminate) dependencies.terminate();
        else process.kill(process.pid, "SIGTERM");
      }
    }
  }

  function send(event: WorkerEvent): void {
    if (!conn.connected || !conn.socket || conn.socket.destroyed) return;
    if (
      task.round !== undefined &&
      event.type !== "ready" &&
      event.type !== "session_update"
    ) {
      event = { round: task.round, ...event };
    }
    if (
      event.type === "ready" ||
      event.type === "session_state" ||
      event.type === "stats" ||
      event.type === "model_select"
    ) {
      event = { ...modelMetadata(session.context?.model), ...event };
    }
    const frame = `${JSON.stringify(event)}\n`;
    if (
      conn.socket.writableLength + Buffer.byteLength(frame) >
      MAX_WRITE_BUFFER_BYTES
    ) {
      loseParent();
      return;
    }
    try {
      conn.socket.write(frame);
    } catch {
      loseParent();
    }
  }

  function reportSession(
    state: BackendSessionState,
    activity?: string,
    force = false,
  ): void {
    const text = activity
      ? truncateUtf8(activity, MAX_ACTIVITY_BYTES).text
      : undefined;
    if (!force && state === session.state && text === session.activity) return;
    session.state = state;
    session.activity = text;
    send({
      type: "session_state",
      id: config.id,
      state,
      ...(text ? { activity: text } : {}),
    });
  }

  function sendStats(): void {
    const percent = session.context?.getContextUsage?.()?.percent;
    send({
      type: "stats",
      id: config.id,
      turnCount: task.turnCount,
      toolUses: task.toolUses,
      totalTokens: task.totalTokens,
      compactionCount: task.compactionCount,
      ...(typeof percent === "number" && Number.isFinite(percent)
        ? { contextPercent: percent }
        : {}),
    });
  }

  function complete(): void {
    if ((!task.active && !task.preparing) || !session.context) return;
    if (
      task.active ||
      !nativeInputPending(session.state, session.context.isIdle())
    ) {
      reportSession("idle");
    }
    send({
      type: "completed",
      id: config.id,
      result: task.result,
      ...(task.error ? { error: task.error } : {}),
      ...(task.canceling || task.aborted ? { canceled: true } : {}),
      ...(task.truncated ? { truncated: true } : {}),
      sessionPath: session.context.sessionManager.getSessionFile(),
    });
    resetTask();
  }

  function reject(text: string): void {
    send({
      type: "activity",
      id: config.id,
      event: "control_rejected",
      text,
      isError: true,
    });
  }

  function receive(command: WorkerCommand): void {
    if (conn.shuttingDown || !conn.connected || !session.context) return;
    // Control and task frames from a previous round must not touch a new batch.
    if (command.type !== "task" && command.round !== task.round) return;
    if (command.type === "task") {
      if ((task.active || task.preparing) && command.round !== task.round)
        return;
      if (
        !task.active &&
        !task.preparing &&
        ((command.round !== undefined && command.round <= session.lastRound) ||
          (command.round === undefined && session.lastRound > 1))
      )
        return;
    }
    if (command.type === "cancel") {
      if (!task.active && !task.preparing) return;
      task.canceling = true;
      // A reservation has no Pi prompt or native queues to abort.
      if (task.preparing) {
        complete();
        return;
      }
      task.pendingCommands = 0;
      task.startupQueue = [];
      // TUI ctx.abort synchronously clears both native queues, but restores
      // them into the editor. Preserve the editor, not canceled IPC prompts.
      const editorText = session.context.ui.getEditorText();
      session.context.abort();
      session.context.ui.setEditorText(editorText);
      return;
    }
    if (task.canceling) {
      reject("Cancellation is pending; wait for completed");
      return;
    }
    if (command.type === "steer" && !task.active && !task.preparing) {
      reject("No active worker task to steer");
      return;
    }
    if (task.pendingCommands >= MAX_PENDING_COMMANDS) {
      reject("Too many pending worker messages");
      return;
    }
    // Pi's initial submission is asynchronous. Do not race multiple prompts
    // through preflight before streaming starts; native queueing is then safe.
    if ((task.active || task.preparing) && !task.started) {
      task.startupQueue.push(command);
      task.pendingCommands += 1;
      return;
    }
    if (
      command.type === "task" &&
      !task.active &&
      nativeInputPending(session.state, session.context.isIdle())
    ) {
      session.lastRound = Math.max(session.lastRound, command.round ?? 1);
      // Non-agent operations (e.g. manual compaction) may have no agent_settled.
      // Reject runtime busy without latching a synthetic interactive state.
      if (session.state === "interactive") {
        reportSession("interactive", session.activity ?? "Thinking…", true);
      }
      send({
        type: "completed",
        id: config.id,
        result: "",
        ...(command.round !== undefined ? { round: command.round } : {}),
        error: "Subagent is busy with user interaction; wait until idle.",
        sessionPath: session.context.sessionManager.getSessionFile(),
      });
      return;
    }
    const wasActive = task.active;
    if (!task.active) {
      resetTask();
      task.preparing = true;
      task.round = command.round;
      session.lastRound = Math.max(session.lastRound, task.round ?? 1);
    }
    task.pendingCommands += 1;
    if (wasActive) submit(command, true);
    else void prepare(command);
  }

  async function prepare(command: Exclude<WorkerCommand, { type: "cancel" }>) {
    if (!session.context) return;
    const current = task.generation;
    const ctx = session.context;
    task.preparing = true;
    try {
      if (command.type === "task" && command.instructions?.tools) {
        const activeTools = new Set(pi.getActiveTools());
        const missing = command.instructions.tools.filter(
          (name) => !activeTools.has(name),
        );
        if (missing.length) {
          throw new Error(
            `Requested tools are unavailable: ${missing.join(", ")}. Check subagent.extensionAllowlist.`,
          );
        }
      }
      if (!ctx.model) throw new Error("No Pi model selected");
      if (!ctx.modelRegistry.hasConfiguredAuth(ctx.model)) {
        const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
        if (!auth.ok) throw new Error(auth.error);
      }
      if (task.generation !== current) return;
      // Auth can yield to native input or non-agent operations. Commit only
      // while still idle, with no await between this check and submission.
      if (nativeInputPending(session.state, ctx.isIdle())) {
        throw new Error(
          "Subagent is busy with user interaction; wait until idle.",
        );
      }
      task.preparing = false;
      task.active = true;
      reportSession("running");
      submit(command, false);
    } catch (cause) {
      if (task.generation !== current) return;
      task.error = truncateUtf8(String(cause), MAX_ACTIVITY_BYTES).text;
      complete();
    }
  }

  function submit(
    command: Exclude<WorkerCommand, { type: "cancel" }>,
    wasActive: boolean,
  ): void {
    try {
      const text = command.type === "task" ? command.prompt : command.message;
      // Always specify delivery: isIdle can briefly be true during recovery
      // or before a submitted prompt starts. Pi starts a turn if truly idle.
      pi.sendUserMessage(text, {
        deliverAs: command.type === "task" ? "followUp" : "steer",
        expandPromptTemplates: false,
      });
    } catch (cause) {
      task.pendingCommands -= 1;
      if (wasActive) {
        reject("Pi rejected the worker message");
      } else {
        task.error = truncateUtf8(String(cause), MAX_ACTIVITY_BYTES).text;
        complete();
      }
    }
  }

  function nativeStart(): void {
    if (task.active) return;
    reportSession("interactive", "Thinking…");
    if (task.preparing) {
      task.error = "Subagent is busy with user interaction; wait until idle.";
      complete(); // Invalidates the reservation, never the native run.
    }
    // before_agent_start and agent_start can both fire, including on retries.
    native.interaction ??= {
      type: "session_update",
      interactionId: randomUUID(),
      sequence: ++native.sequence,
      response: "",
      outcome: "completed",
    };
  }

  pi.on("session_start", (_event, ctx) => {
    if (conn.shuttingDown) return;
    disconnect();
    resetTask();
    native.interaction = undefined;
    session.state = "idle";
    session.activity = undefined;
    session.lastRound = 0;
    session.context = ctx;
    if (ctx.mode !== "tui") return;
    const connection = dependencies.connect(config);
    conn.socket = connection;
    connection.setNoDelay(true);
    connection.unref();
    const read = createWorkerJsonlReader(receive);
    connection.on("connect", () => {
      if (conn.socket !== connection) return;
      conn.connected = true;
      send({
        type: "ready",
        id: config.id,
        token: config.token,
        sessionPath: ctx.sessionManager.getSessionFile(),
      });
      reportSession(session.state, session.activity, true);
    });
    connection.on("data", (chunk: Buffer) => {
      if (conn.socket !== connection) return;
      try {
        read(chunk);
      } catch {
        loseParent();
      }
    });
    connection.on("error", () => {
      if (conn.socket === connection) loseParent();
    });
    connection.on("close", () => {
      if (conn.socket === connection) loseParent();
    });
  });

  pi.on("model_select", (event, ctx) => {
    session.context = ctx;
    send({
      type: "model_select",
      id: config.id,
      ...modelMetadata(event.model),
    });
  });

  // Handle cancellation in the small window between submission and startup.
  pi.on("input", (event, ctx) => {
    session.context = ctx;
    if (task.active && task.canceling && event.source === "extension") {
      if (!task.started) complete();
      return { action: "handled" };
    }
  });

  pi.on("before_agent_start", (_event, ctx) => {
    session.context = ctx;
    nativeStart();
    if (task.active && task.canceling) ctx.abort();
  });

  pi.on("agent_start", (_event, ctx) => {
    session.context = ctx;
    if (!task.active) {
      nativeStart();
      return;
    }
    if (!task.started) {
      task.started = true;
      send({ type: "started", id: config.id });
    }
    send({ type: "activity", id: config.id, event: "agent_start" });
    if (task.canceling) {
      ctx.abort();
    } else {
      const queued = task.startupQueue;
      task.startupQueue = [];
      task.pendingCommands -= queued.length;
      for (const command of queued) receive(command);
    }
  });

  pi.on("message_end", (event, ctx) => {
    session.context = ctx;
    if (!task.active) {
      if (native.interaction && event.message.role === "assistant") {
        const final = truncateUtf8(
          messageText(event.message),
          MAX_RESULT_BYTES,
        );
        native.interaction.response = final.text;
        native.interaction.truncated = final.truncated || undefined;
        native.interaction.outcome =
          event.message.stopReason === "error"
            ? "error"
            : event.message.stopReason === "aborted"
              ? "aborted"
              : "completed";
        // A later reply replaces transient retry errors and partial output.
        native.interaction.error =
          native.interaction.outcome === "error"
            ? truncateUtf8(
                event.message.errorMessage || "Pi assistant failed",
                MAX_ACTIVITY_BYTES,
              ).text
            : undefined;
      }
      return;
    }
    if (event.message.role === "user") {
      task.pendingCommands = Math.max(0, task.pendingCommands - 1);
    }
    const preview = truncateUtf8(
      messageText(event.message),
      MAX_ACTIVITY_BYTES,
    );
    send({
      type: "activity",
      id: config.id,
      event: "message_end",
      role: event.message.role,
      text: preview.text,
      ...(preview.truncated ? { truncated: true } : {}),
    });
    if (event.message.role === "assistant") {
      task.turnCount += 1;
      const usage = event.message.usage;
      // Managed-task usage excludes cacheRead, which repeats the cached prefix.
      task.totalTokens +=
        (usage?.input ?? 0) + (usage?.output ?? 0) + (usage?.cacheWrite ?? 0);
      sendStats();
      const final = truncateUtf8(messageText(event.message), MAX_RESULT_BYTES);
      task.result = final.text;
      task.truncated = final.truncated;
      // A later successful retry must replace a transient error/abort.
      task.error =
        event.message.stopReason === "error"
          ? truncateUtf8(
              event.message.errorMessage || "Pi assistant failed",
              MAX_ACTIVITY_BYTES,
            ).text
          : undefined;
      task.aborted = event.message.stopReason === "aborted";
    }
  });

  pi.on("tool_execution_start", (event, ctx) => {
    session.context = ctx;
    if (!task.active) {
      if (session.state === "interactive") {
        reportSession("interactive", event.toolName);
      }
      return;
    }
    task.toolUses += 1;
    sendStats();
    send({
      type: "activity",
      id: config.id,
      event: "tool_execution_start",
      toolName: event.toolName,
      toolCallId: event.toolCallId,
      parentToolCallId: event.parentToolCallId,
    });
  });

  pi.on("tool_execution_end", (event, ctx) => {
    session.context = ctx;
    if (!task.active) {
      if (session.state === "interactive") {
        reportSession("interactive", "Thinking…");
      }
      return;
    }
    send({
      type: "activity",
      id: config.id,
      event: "tool_execution_end",
      toolName: event.toolName,
      toolCallId: event.toolCallId,
      parentToolCallId: event.parentToolCallId,
      isError: event.isError,
    });
  });

  pi.on("session_compact", (_event, ctx) => {
    session.context = ctx;
    if (!task.active) return;
    task.compactionCount += 1;
    sendStats();
  });

  pi.on("agent_end", (_event, ctx) => {
    session.context = ctx;
    if (task.active) {
      send({ type: "activity", id: config.id, event: "agent_end" });
    }
  });

  pi.on("agent_before_settle", (event, ctx) => {
    session.context = ctx;
    if (task.active || !native.interaction) return;
    // This boundary also supplies an outcome when no assistant reply exists.
    // It is actionable, so retain state until the notification-only settlement.
    native.interaction.outcome = event.outcome;
    native.interaction.error =
      event.outcome === "error"
        ? native.interaction.error || "Pi assistant failed"
        : undefined;
  });

  // Installed Pi declares agent_settled. Do not substitute agent_end or an
  // idle timeout: both can precede retries, compaction and follow-up work.
  pi.on("agent_settled", (_event, ctx) => {
    session.context = ctx;
    const settledInteraction = native.interaction;
    native.interaction = undefined;
    reportSession("idle");
    if (task.active) complete();
    else if (settledInteraction) send({ ...settledInteraction, id: config.id });
  });

  pi.on("session_shutdown", () => {
    disconnect();
    resetTask();
    native.interaction = undefined;
    session.context = undefined;
  });
}

export default function workerExtension(pi: ExtensionAPI): void {
  const config = readWorkerConfig();
  if (config) registerWorkerBridge(pi, config);
}
