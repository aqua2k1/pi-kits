import { createConnection, type Socket } from "node:net";
import type {
  ExtensionAPI,
  ExtensionContext,
  MessageEndEvent,
} from "@earendil-works/pi-coding-agent";

import {
  MAX_COMMAND_BYTES,
  MAX_PENDING_COMMANDS,
  MAX_RESULT_BYTES,
  type WorkerSessionState,
} from "./protocol.ts";

export {
  MAX_COMMAND_BYTES,
  MAX_PENDING_COMMANDS,
  MAX_RESULT_BYTES,
  type WorkerSessionState,
} from "./protocol.ts";

/** Manager listens on loopback; explicitly load this file with pi -e. */
export const WORKER_MARKER = "PI_KITS_SUBAGENT_WORKER";
const MAX_WRITE_BUFFER_BYTES = 1024 * 1024;
const MAX_ACTIVITY_BYTES = 4096;

/** LF-delimited JSON. Authentication is the manager's validation of ready.token.
 * A busy task joins the current batch as followUp; one completed covers the
 * entire batch, including steering, retries and automatic continuations.
 * Manager must await completed before assigning an independent task.
 */
export interface WorkerInstructions {
  systemPrompt: string;
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
) & { round?: number };

export interface WorkerConfig {
  host: "127.0.0.1";
  port: number;
  token: string;
  id: string;
}

export interface WorkerDependencies {
  connect(config: WorkerConfig): Socket;
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
      typeof instructions.systemPrompt !== "string" ||
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
        systemPrompt: instructions.systemPrompt,
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

function boundedText(
  text: string,
  maxBytes: number,
): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text) <= maxBytes) return { text, truncated: false };
  let bytes = 0;
  let end = 0;
  for (const character of text) {
    bytes += Buffer.byteLength(character);
    if (bytes > maxBytes) break;
    end += character.length;
  }
  return { text: text.slice(0, end), truncated: true };
}

function messageText(message: MessageEndEvent["message"]): string {
  if (!("content" in message)) return "";
  if (typeof message.content === "string") return message.content;
  return message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

/** Testable factory; no resources are created until session_start in TUI mode.
 * Sockets are never used as Pi's stdin/stdout and disconnect never aborts Pi.
 * There is no reconnect/replay: the manager should treat disconnect as detached.
 */
export function registerWorkerBridge(
  pi: ExtensionAPI,
  config: WorkerConfig,
  dependencies: WorkerDependencies = {
    connect: ({ host, port }) => createConnection({ host, port }),
  },
): void {
  let socket: Socket | undefined;
  let connected = false;
  let sessionState: WorkerSessionState = "idle";
  let sessionActivity: string | undefined;
  let context: ExtensionContext | undefined;
  let active = false;
  let round: number | undefined;
  let lastRound = 0;
  let started = false;
  let canceling = false;
  let pendingCommands = 0;
  let startupQueue: WorkerCommand[] = [];
  let generation = 0;
  let preparing = false;
  let result = "";
  let instructions: WorkerInstructions | undefined;
  let turnCount = 0;
  let toolUses = 0;
  let totalTokens = 0;
  let compactionCount = 0;
  let truncated = false;
  let error: string | undefined;
  let aborted = false;

  function disconnect(): void {
    connected = false;
    const previous = socket;
    socket = undefined;
    previous?.destroy();
  }

  function send(event: WorkerEvent): void {
    if (!connected || !socket || socket.destroyed) return;
    if (round !== undefined && event.type !== "ready") {
      event = { round, ...event };
    }
    const frame = `${JSON.stringify(event)}\n`;
    if (
      socket.writableLength + Buffer.byteLength(frame) >
      MAX_WRITE_BUFFER_BYTES
    ) {
      disconnect();
      return;
    }
    try {
      socket.write(frame);
    } catch {
      disconnect();
    }
  }

  function reportSession(
    state: WorkerSessionState,
    activity?: string,
    force = false,
  ): void {
    const text = activity
      ? boundedText(activity, MAX_ACTIVITY_BYTES).text
      : undefined;
    if (!force && state === sessionState && text === sessionActivity) return;
    sessionState = state;
    sessionActivity = text;
    send({
      type: "session_state",
      id: config.id,
      state,
      ...(text ? { activity: text } : {}),
    });
  }

  function reset(): void {
    generation += 1;
    preparing = false;
    active = false;
    round = undefined;
    started = false;
    canceling = false;
    pendingCommands = 0;
    startupQueue = [];
    result = "";
    turnCount = 0;
    toolUses = 0;
    totalTokens = 0;
    compactionCount = 0;
    truncated = false;
    error = undefined;
    aborted = false;
  }

  function sendStats(): void {
    const percent = context?.getContextUsage?.()?.percent;
    send({
      type: "stats",
      id: config.id,
      turnCount,
      toolUses,
      totalTokens,
      compactionCount,
      ...(typeof percent === "number" && Number.isFinite(percent)
        ? { contextPercent: percent }
        : {}),
    });
  }

  function complete(): void {
    if (!active || !context) return;
    reportSession("idle");
    send({
      type: "completed",
      id: config.id,
      result,
      ...(error ? { error } : {}),
      ...(canceling || aborted ? { canceled: true } : {}),
      ...(truncated ? { truncated: true } : {}),
      sessionPath: context.sessionManager.getSessionFile(),
    });
    reset();
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
    if (!connected || !context) return;
    // Control and task frames from a previous round must not touch a new batch.
    if (command.type !== "task" && command.round !== round) return;
    if (command.type === "task") {
      if (active && command.round !== round) return;
      if (
        !active &&
        ((command.round !== undefined && command.round <= lastRound) ||
          (command.round === undefined && lastRound > 1))
      )
        return;
    }
    if (command.type === "cancel") {
      if (!active) return;
      canceling = true;
      pendingCommands = 0;
      startupQueue = [];
      // TUI ctx.abort synchronously clears both native queues, but restores
      // them into the editor. Preserve the editor, not canceled IPC prompts.
      const editorText = context.ui.getEditorText();
      context.abort();
      context.ui.setEditorText(editorText);
      // No Pi prompt exists yet while checking credentials.
      if (preparing) complete();
      return;
    }
    if (canceling) {
      reject("Cancellation is pending; wait for completed");
      return;
    }
    if (command.type === "steer" && !active) {
      reject("No active worker task to steer");
      return;
    }
    if (pendingCommands >= MAX_PENDING_COMMANDS) {
      reject("Too many pending worker messages");
      return;
    }
    // Pi's initial submission is asynchronous. Do not race multiple prompts
    // through preflight before streaming starts; native queueing is then safe.
    if (active && !started) {
      startupQueue.push(command);
      pendingCommands += 1;
      return;
    }
    if (
      command.type === "task" &&
      !active &&
      (sessionState === "interactive" || !context.isIdle())
    ) {
      lastRound = Math.max(lastRound, command.round ?? 1);
      // Non-agent operations (e.g. manual compaction) may have no agent_settled.
      // Reject runtime busy without latching a synthetic interactive state.
      if (sessionState === "interactive") {
        reportSession("interactive", sessionActivity ?? "Thinking…", true);
      }
      send({
        type: "completed",
        id: config.id,
        result: "",
        ...(command.round !== undefined ? { round: command.round } : {}),
        error: "Subagent is busy with user interaction; wait until idle.",
        sessionPath: context.sessionManager.getSessionFile(),
      });
      return;
    }
    const wasActive = active;
    if (!active) {
      reset();
      active = true;
      round = command.round;
      lastRound = Math.max(lastRound, round ?? 1);
      if (command.type === "task") instructions = command.instructions;
      reportSession("running");
    }
    pendingCommands += 1;
    if (wasActive) submit(command, true);
    else void prepare(command);
  }

  async function prepare(command: Exclude<WorkerCommand, { type: "cancel" }>) {
    if (!context) return;
    const current = generation;
    const ctx = context;
    preparing = true;
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
      if (generation !== current) return;
      preparing = false;
      submit(command, false);
    } catch (cause) {
      if (generation !== current) return;
      preparing = false;
      error = boundedText(String(cause), MAX_ACTIVITY_BYTES).text;
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
      pendingCommands -= 1;
      if (wasActive) {
        reject("Pi rejected the worker message");
      } else {
        error = boundedText(String(cause), MAX_ACTIVITY_BYTES).text;
        complete();
      }
    }
  }

  pi.on("session_start", (_event, ctx) => {
    disconnect();
    reset();
    sessionState = "idle";
    sessionActivity = undefined;
    lastRound = 0;
    context = ctx;
    if (ctx.mode !== "tui") return;
    const connection = dependencies.connect(config);
    socket = connection;
    connection.setNoDelay(true);
    connection.unref();
    const read = createWorkerJsonlReader(receive);
    connection.on("connect", () => {
      if (socket !== connection) return;
      connected = true;
      send({
        type: "ready",
        id: config.id,
        token: config.token,
        sessionPath: ctx.sessionManager.getSessionFile(),
      });
      reportSession(sessionState, sessionActivity, true);
    });
    connection.on("data", (chunk: Buffer) => {
      if (socket !== connection) return;
      try {
        read(chunk);
      } catch {
        disconnect();
      }
    });
    connection.on("error", () => {
      if (socket === connection) disconnect();
    });
    connection.on("close", () => {
      if (socket === connection) disconnect();
    });
  });

  // Handle cancellation in the small window between submission and startup.
  pi.on("input", (event, ctx) => {
    context = ctx;
    if (active && canceling && event.source === "extension") {
      if (!started) complete();
      return { action: "handled" };
    }
  });
  pi.on("before_agent_start", (_event, ctx) => {
    context = ctx;
    if (!active) reportSession("interactive", "Thinking…");
    if (active && canceling) ctx.abort();
    if (instructions) {
      return {
        systemPrompt: instructions.systemPrompt,
      };
    }
  });
  pi.on("agent_start", (_event, ctx) => {
    context = ctx;
    if (!active) {
      reportSession("interactive", "Thinking…");
      return;
    }
    if (!started) {
      started = true;
      send({ type: "started", id: config.id });
    }
    send({ type: "activity", id: config.id, event: "agent_start" });
    if (canceling) {
      ctx.abort();
    } else {
      const queued = startupQueue;
      startupQueue = [];
      pendingCommands -= queued.length;
      for (const command of queued) receive(command);
    }
  });
  pi.on("message_end", (event, ctx) => {
    context = ctx;
    if (!active) return;
    if (event.message.role === "user") {
      pendingCommands = Math.max(0, pendingCommands - 1);
    }
    const preview = boundedText(messageText(event.message), MAX_ACTIVITY_BYTES);
    send({
      type: "activity",
      id: config.id,
      event: "message_end",
      role: event.message.role,
      text: preview.text,
      ...(preview.truncated ? { truncated: true } : {}),
    });
    if (event.message.role === "assistant") {
      turnCount += 1;
      const usage = event.message.usage;
      // Managed-task usage excludes cacheRead, which repeats the cached prefix.
      totalTokens +=
        (usage?.input ?? 0) + (usage?.output ?? 0) + (usage?.cacheWrite ?? 0);
      sendStats();
      const final = boundedText(messageText(event.message), MAX_RESULT_BYTES);
      result = final.text;
      truncated = final.truncated;
      // A later successful retry must replace a transient error/abort.
      error =
        event.message.stopReason === "error"
          ? boundedText(
              event.message.errorMessage || "Pi assistant failed",
              MAX_ACTIVITY_BYTES,
            ).text
          : undefined;
      aborted = event.message.stopReason === "aborted";
    }
  });
  pi.on("tool_execution_start", (event, ctx) => {
    context = ctx;
    if (!active) {
      if (sessionState === "interactive") {
        reportSession("interactive", event.toolName);
      }
      return;
    }
    toolUses += 1;
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
    context = ctx;
    if (!active) {
      if (sessionState === "interactive") {
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
    context = ctx;
    if (!active) return;
    compactionCount += 1;
    sendStats();
  });
  pi.on("agent_end", (_event, ctx) => {
    context = ctx;
    if (active) {
      send({ type: "activity", id: config.id, event: "agent_end" });
    }
  });
  // Installed Pi declares agent_settled. Do not substitute agent_end or an
  // idle timeout: both can precede retries, compaction and follow-up work.
  pi.on("agent_settled", (_event, ctx) => {
    context = ctx;
    reportSession("idle");
    complete();
  });
  pi.on("session_shutdown", () => {
    disconnect();
    reset();
    context = undefined;
  });
}

export default function workerExtension(pi: ExtensionAPI): void {
  const config = readWorkerConfig();
  if (config) registerWorkerBridge(pi, config);
}
