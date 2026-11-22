import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  SUBAGENT_DEFAULT_EXTENSIONS,
  type WorkerExtensionSource,
} from "@pi-kits/config";
import { type TerminalHandle, TerminalStartError } from "../../mux/index.ts";
import {
  type AgentRuntime,
  MAX_COMMAND_BYTES,
  type RuntimeCapabilities,
  type RuntimeCommand,
  type RuntimeEvent,
  type RuntimeHost,
  type RuntimeOptions,
  type RuntimeSession,
} from "../index.ts";
import {
  captureParentSession,
  createClonedSession,
  type ParentSessionSnapshot,
} from "./clone.ts";
import {
  type PiConfig,
  parsePiCallConfig,
  parsePiConfig,
  parsePiTask,
  piConfig,
} from "./config.ts";
import { resolveWorkerExtensions } from "./extensions.ts";

const MAX_FRAME_BYTES = 1_048_576;
const capabilities: RuntimeCapabilities = Object.freeze({
  nativeClone: true,
  steer: true,
  retainedSession: true,
  concurrentNativeInput: true,
});

export interface PiRuntimeOptions {
  extensionAllowlist?: readonly WorkerExtensionSource[];
  workerPath?: string;
  executable?: string;
}

function validatePiOptions(
  options: RuntimeOptions,
  config = piConfig(options),
): void {
  if (config.prompt_mode !== undefined && !options.agent) {
    throw new Error("Pi prompt_mode requires a named agent body");
  }
  if (
    options.agent &&
    (config.prompt_mode ?? "replace") === "replace" &&
    !options.agent.systemPrompt.trim()
  ) {
    throw new Error("Pi replace prompt_mode requires a non-empty agent body");
  }
}

function preparePiSpawn(options: RuntimeOptions): RuntimeOptions {
  if (!piConfig(options).inherit_context || options.parentSession) {
    return { ...options, context: undefined };
  }
  const context = options.context;
  if (
    !context ||
    typeof context !== "object" ||
    !["getBranch", "getHeader", "getSessionFile", "getSessionDir"].every(
      (method) =>
        typeof (context as Record<string, unknown>)[method] === "function",
    )
  ) {
    throw new Error(
      "Pi inherit_context requires a valid host session context (sessionManager)",
    );
  }
  return {
    ...options,
    parentSession: captureParentSession(
      context as ExtensionContext["sessionManager"],
    ),
    context: undefined,
  };
}

function buildPiArgv(
  options: RuntimeOptions,
  config: PiConfig,
  defaults: PiRuntimeOptions,
  extensions: readonly string[],
  sessionFlag: readonly [string, string],
  promptFlags: readonly string[],
): string[] {
  const argv = [
    options.executable ?? defaults.executable ?? "pi",
    "--no-extensions",
    "-e",
    defaults.workerPath ??
      fileURLToPath(new URL("./worker.ts", import.meta.url)),
  ];
  for (const extension of extensions) argv.push("-e", extension);
  argv.push(...sessionFlag);
  if (options.sessionName) argv.push("--name", options.sessionName);
  const model = options.agent?.model ?? options.model;
  const thinking = options.agent?.thinking ?? options.thinking;
  if (model) argv.push("--model", model);
  if (thinking) argv.push("--thinking", thinking);
  if (config.tools !== undefined) {
    if (config.tools.length) argv.push("--tools", config.tools.join(","));
    else argv.push("--no-tools");
  }
  if (config.disallowed_tools?.length) {
    argv.push("--exclude-tools", config.disallowed_tools.join(","));
  }
  argv.push(...promptFlags);
  return argv;
}

function createPiSession(
  options: RuntimeOptions,
  config: PiConfig,
  host: RuntimeHost,
  defaults: PiRuntimeOptions,
): RuntimeSession {
  const token = randomBytes(32).toString("hex");
  const sockets = new Set<Socket>();
  let terminal: TerminalHandle | undefined;
  let socket: Socket | undefined;
  let server: Server | undefined;
  let authenticated = false;
  let closed = false;
  let starting: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  let promptDirectory: string | undefined;
  let ready: (() => void) | undefined;
  let rejectReady: ((error: Error) => void) | undefined;

  const isConnected = (): boolean =>
    Boolean(socket && !socket.destroyed && !closed);

  const accept = (client: Socket): void => {
    if (closed) {
      client.destroy();
      return;
    }
    sockets.add(client);
    client.setEncoding("utf8");
    client.setTimeout(10_000, () => client.destroy());
    let buffer = "";
    let clientAuthed = false;
    client.on("data", (chunk) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > MAX_FRAME_BYTES) {
        client.destroy();
        return;
      }
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        try {
          const raw = JSON.parse(line) as Record<string, unknown>;
          if (!raw || typeof raw !== "object") throw new Error("Bad frame");
          if (!clientAuthed) {
            if (
              raw.type !== "ready" ||
              raw.id !== options.id ||
              raw.token !== token ||
              authenticated ||
              closed
            ) {
              throw new Error("Worker authentication failed");
            }
            clientAuthed = true;
            authenticated = true;
            socket = client;
            client.setTimeout(0);
            host.emit({
              type: "session_state",
              state: "idle",
              model: typeof raw.model === "string" ? raw.model : undefined,
              modelName:
                typeof raw.modelName === "string" ? raw.modelName : undefined,
              sessionPath:
                typeof raw.sessionPath === "string"
                  ? raw.sessionPath
                  : undefined,
              runtimeSessionId: `subagent-${options.id}`,
            });
            ready?.();
          } else {
            if (typeof raw.type !== "string") throw new Error("Bad frame");
            host.emit(raw as unknown as RuntimeEvent);
          }
        } catch {
          client.destroy();
          return;
        }
        newline = buffer.indexOf("\n");
      }
    });
    client.on("error", () => client.destroy());
    client.on("close", () => {
      sockets.delete(client);
      if (socket !== client) return;
      socket = undefined;
      rejectReady?.(new Error("Pi worker disconnected."));
      if (!closed) {
        host.emit({
          type: "disconnected",
          error: "Pi worker disconnected.",
        });
      }
    });
  };

  const listen = (): Promise<string> =>
    new Promise<string>((resolve, reject) => {
      const listener = createServer(accept);
      server = listener;
      listener.once("error", reject);
      listener.listen(0, "127.0.0.1", () => {
        const address = listener.address();
        if (!address || typeof address === "string") {
          reject(new Error("Could not bind the worker control server."));
          return;
        }
        resolve(`127.0.0.1:${address.port}`);
      });
    });

  const launch = async (): Promise<void> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (closed) throw new Error("Pi worker is closed.");
      const extensions = await resolveWorkerExtensions(
        defaults.extensionAllowlist ?? SUBAGENT_DEFAULT_EXTENSIONS,
      );
      if (closed) throw new Error("Pi worker is closed.");
      const endpoint = await listen();
      if (closed) throw new Error("Pi worker is closed.");
      const awaitingReady = new Promise<void>((resolve, reject) => {
        ready = resolve;
        rejectReady = reject;
        timer = setTimeout(
          () => reject(new Error("Timed out waiting for the Pi worker.")),
          options.startupTimeoutMs ?? 60_000,
        );
      });
      // A terminal startup can outlive cancellation or the ready timeout.
      void awaitingReady.catch(() => undefined);

      let sessionFlag: [string, string];
      if (options.parentSession) {
        const sessionPath = createClonedSession(
          options.parentSession as ParentSessionSnapshot,
          options.cwd,
          `subagent-${options.id}`,
        );
        host.emit({ type: "session_state", state: "idle", sessionPath });
        sessionFlag = ["--session", sessionPath];
      } else {
        sessionFlag = ["--session-id", `subagent-${options.id}`];
      }

      const promptFlags: string[] = [];
      if (options.agent) {
        promptDirectory = mkdtempSync(join(tmpdir(), "pi-kits-prompt-"));
        const promptPath = join(promptDirectory, "system.md");
        writeFileSync(promptPath, options.agent.systemPrompt, { mode: 0o600 });
        if (config.prompt_mode === "append") {
          promptFlags.push("--append-system-prompt", promptPath);
        } else {
          const emptyPath = join(promptDirectory, "append.md");
          writeFileSync(emptyPath, "", { mode: 0o600 });
          promptFlags.push(
            "--system-prompt",
            promptPath,
            "--append-system-prompt",
            emptyPath,
          );
        }
      }

      const argv = buildPiArgv(
        options,
        config,
        defaults,
        extensions,
        sessionFlag,
        promptFlags,
      );
      terminal = await host.mux.start({
        agentId: options.id,
        agentType: options.agent?.name,
        cwd: options.cwd,
        argv,
        env: {
          PI_KITS_SUBAGENT_WORKER: "1",
          PI_KITS_SUBAGENT_ENDPOINT: endpoint,
          PI_KITS_SUBAGENT_TOKEN: token,
          PI_KITS_SUBAGENT_ID: options.id,
        },
      });
      if (closed) throw new Error("Pi worker is closed.");
      await awaitingReady;
      if (!isConnected()) throw new Error("Pi worker disconnected.");
    } catch (error) {
      if (error instanceof TerminalStartError) terminal = error.terminal;
      throw error;
    } finally {
      clearTimeout(timer);
      ready = undefined;
      rejectReady = undefined;
    }
  };

  const cleanup = async (): Promise<void> => {
    await starting?.catch(() => undefined);
    try {
      if (terminal) {
        await host.mux.destroy(terminal);
        terminal = undefined;
      }
      if (promptDirectory) {
        rmSync(promptDirectory, { recursive: true, force: true });
        promptDirectory = undefined;
      }
    } finally {
      // Keep terminal ownership on destroy failure so close can be retried.
      socket = undefined;
      for (const client of sockets) client.destroy();
      if (server?.listening) {
        await new Promise<void>((resolve) => server?.close(() => resolve()));
      }
    }
  };

  return {
    capabilities,
    get connected() {
      return isConnected();
    },
    get terminal() {
      return terminal;
    },
    start() {
      starting ??= launch();
      return starting;
    },
    send(command: RuntimeCommand) {
      const normalized = parsePiTask(command, options);
      if (!isConnected()) throw new Error("Pi worker is not connected.");
      const frame = JSON.stringify(normalized);
      if (Buffer.byteLength(frame) > MAX_COMMAND_BYTES) {
        throw new Error("Subagent command exceeds the 64 KiB protocol limit.");
      }
      socket?.write(`${frame}\n`);
    },
    async inspect() {
      return Boolean(
        isConnected() && terminal && (await host.mux.inspect(terminal)).alive,
      );
    },
    async attachment() {
      if (!terminal || closed) {
        throw new Error("Subagent terminal is not ready yet.");
      }
      return terminal;
    },
    close() {
      closed = true;
      rejectReady?.(new Error("Pi worker closed during startup."));
      if (closing) return closing;
      const operation = cleanup();
      closing = operation;
      const clear = () => {
        closing = undefined;
      };
      void operation.then(clear, clear);
      return operation;
    },
  };
}

/** Pi owns its worker process and authenticated, one-shot TCP transport. */
export function createPiRuntime(defaults: PiRuntimeOptions = {}) {
  return {
    id: "pi" as const,
    displayName: "Pi",
    capabilities,
    parseConfig: parsePiConfig,
    parseCallConfig: parsePiCallConfig,
    parseTask: parsePiTask,
    validate: validatePiOptions,
    prepareSpawn: preparePiSpawn,
    create(options: RuntimeOptions, host: RuntimeHost): RuntimeSession {
      const config = piConfig(options);
      validatePiOptions(options, config);
      return createPiSession(
        { ...options, runtimeConfig: config },
        config,
        host,
        defaults,
      );
    },
  } satisfies AgentRuntime;
}
