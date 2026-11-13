import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import {
  type MuxAdapter,
  type OpenViewOptions,
  type StartOptions,
  type TerminalHandle,
  TerminalStartError,
  type ViewHandle,
} from "./index.ts";
import { registerMux } from "./registry.ts";

export interface HerdrAppRunOptions {
  timeoutMs: number;
  maxOutputBytes: number;
  env: NodeJS.ProcessEnv;
  /** One newline-delimited JSON-RPC request for hc connect. */
  input: string;
}

export interface HerdrAppRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type HerdrAppRunner = (
  binary: string,
  argv: string[],
  options: HerdrAppRunOptions,
) => Promise<HerdrAppRunResult>;

export interface HerdrAppOptions {
  runner?: HerdrAppRunner;
  env?: NodeJS.ProcessEnv;
  binPath?: string;
  warn?: (message: string) => void;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

/** Never exposes RPC parameters, worker tokens or server-provided messages. */
export class HerdrAppError extends Error {
  constructor(
    public readonly code: string,
    public readonly requestRejected = false,
  ) {
    super(`Herdr app: ${code}`);
    this.name = "HerdrAppError";
  }
}

/** Keep stdin open until the reply arrives; EOF before it can lose a launch reply. */
export const runHerdrApp: HerdrAppRunner = (binary, argv, options) =>
  new Promise((resolve, reject) => {
    let outputBytes = 0;
    let outputExceeded = false;
    const child = execFile(
      binary,
      argv,
      {
        encoding: "utf8",
        shell: false,
        env: options.env,
        timeout: options.timeoutMs,
        maxBuffer: options.maxOutputBytes,
        killSignal: "SIGKILL",
      },
      (error, stdout, stderr) => {
        if (outputExceeded) {
          reject(new HerdrAppError("output_limit"));
          return;
        }
        if (error && typeof error.code !== "number") {
          reject(
            new HerdrAppError(
              error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
                ? "output_limit"
                : error.killed
                  ? "timeout"
                  : error.code === "ENOENT" || error.code === "EACCES"
                    ? "binary_unavailable"
                    : "runner_failed",
            ),
          );
          return;
        }
        resolve({
          exitCode: typeof error?.code === "number" ? error.code : 0,
          stdout,
          stderr,
        });
      },
    );
    const observe = (chunk: string) => {
      outputBytes += Buffer.byteLength(chunk);
      if (outputBytes > options.maxOutputBytes) {
        outputExceeded = true;
        child.kill("SIGKILL");
      }
    };
    child.stdin?.on("error", () => {});
    child.stdout?.on("data", (chunk: string) => {
      observe(chunk);
      if (chunk.includes("\n")) child.stdin?.end();
    });
    child.stderr?.on("data", observe);
    child.stdin?.write(options.input);
  });

type JsonObject = Record<string, unknown>;
const OWNER_LABEL = "pi-kits.subagent.owner";
// Only documented codes may cross the boundary; arbitrary server strings can
// contain worker tokens even when they look like valid lowercase identifiers.
const RPC_ERROR_CODES = new Set([
  "invalid_params",
  "name_taken",
  "spawn_failed",
  "unavailable",
  "invalid_template",
  "not_found",
  "machine_unknown",
  "config",
  "live",
]);
const LAUNCH_REJECTED_CODES = new Set([
  "invalid_params",
  "name_taken",
  "invalid_template",
  "not_found",
  "machine_unknown",
  "config",
]);

function object(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HerdrAppError("invalid_response");
  }
  return value as JsonObject;
}

function address(value: unknown): string {
  // Use immutable terminal addresses, never names, for destructive operations.
  if (typeof value !== "string" || !/^t[0-9a-z]+$/.test(value)) {
    throw new HerdrAppError("invalid_response");
  }
  return value;
}

function notFound(error: unknown): boolean {
  return error instanceof HerdrAppError && error.code === "not_found";
}

interface Worker {
  name: string;
  owner: string;
  parent: string;
  address?: string;
  launchUncertain: boolean;
}

/**
 * The Herdr app integration owns hc terminals, not the user's app or core.
 * hc connect's JSON-line API preserves argv/env without shell interpolation.
 */
export class HerdrAppAdapter implements MuxAdapter {
  private readonly runner: HerdrAppRunner;
  private readonly env: NodeJS.ProcessEnv;
  private readonly binary: string;
  private readonly warn: (message: string) => void;
  private readonly timeoutMs: number;
  private readonly maxOutputBytes: number;
  private readonly workers = new Map<string, Worker>();
  private readonly views = new Set<string>();
  private readonly closedViews = new Set<string>();
  private mutation: Promise<void> = Promise.resolve();

  constructor(options: HerdrAppOptions = {}) {
    this.runner = options.runner ?? runHerdrApp;
    // Pin the core session and inherited environment for this adapter's handles.
    this.env = { ...(options.env ?? process.env) };
    this.binary = options.binPath ?? "hc";
    this.warn = options.warn ?? console.warn;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.maxOutputBytes = options.maxOutputBytes ?? 1024 * 1024;
    for (const value of [this.timeoutMs, this.maxOutputBytes]) {
      if (!Number.isSafeInteger(value) || value <= 0) {
        throw new HerdrAppError("invalid_limits");
      }
    }
  }

  check_env(): boolean {
    return Boolean(this.env.HC_TERMINAL_ID?.trim());
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutation.then(operation);
    this.mutation = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  private async rpc(method: string, params: JsonObject): Promise<JsonObject> {
    let output: HerdrAppRunResult;
    try {
      output = await this.runner(this.binary, ["connect"], {
        timeoutMs: this.timeoutMs,
        maxOutputBytes: this.maxOutputBytes,
        env: { ...this.env },
        input: `${JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })}\n`,
      });
    } catch (error) {
      throw error instanceof HerdrAppError
        ? error
        : new HerdrAppError("runner_failed");
    }
    if (
      Buffer.byteLength(output.stdout) + Buffer.byteLength(output.stderr) >
      this.maxOutputBytes
    ) {
      throw new HerdrAppError("output_limit");
    }
    let reply: JsonObject;
    try {
      reply = object(JSON.parse(output.stdout));
    } catch {
      throw new HerdrAppError(
        output.exitCode === 0 ? "invalid_response" : "cli_failed",
      );
    }
    if (reply.id !== 1 || reply.jsonrpc !== "2.0") {
      throw new HerdrAppError("invalid_response");
    }
    if ("error" in reply) {
      const error = object(reply.error);
      const kind = object(error.data).kind;
      const code =
        typeof kind === "string" && RPC_ERROR_CODES.has(kind)
          ? kind
          : "server_error";
      throw new HerdrAppError(code, LAUNCH_REJECTED_CODES.has(code));
    }
    if (output.exitCode !== 0) throw new HerdrAppError("cli_failed");
    return object(reply.result);
  }

  private worker(handle: TerminalHandle): Worker {
    const worker = this.workers.get(handle.id);
    if (!worker) throw new HerdrAppError("unowned_terminal");
    return worker;
  }

  private async facts(worker: Worker): Promise<JsonObject | undefined> {
    let result: JsonObject;
    try {
      result = await this.rpc("terminal.get", {
        terminal: worker.address ?? worker.name,
      });
    } catch (error) {
      if (notFound(error)) return undefined;
      throw error;
    }
    const actual = address(result.address);
    if (
      (worker.address && actual !== worker.address) ||
      object(result.labels)[OWNER_LABEL] !== worker.owner ||
      result.parent !== worker.parent
    ) {
      throw new HerdrAppError("terminal_identity_changed");
    }
    worker.address = actual;
    if (result.state !== "live" && result.state !== "finished") {
      throw new HerdrAppError("invalid_response");
    }
    worker.launchUncertain = false;
    return result;
  }

  start(options: StartOptions): Promise<TerminalHandle> {
    return this.serialize(async () => {
      if (!this.check_env()) throw new HerdrAppError("not_in_herdr_app");
      const parent = address(this.env.HC_TERMINAL_ID);
      if (
        !isAbsolute(options.cwd) ||
        !options.argv.length ||
        options.argv.some(
          (arg) => typeof arg !== "string" || arg.includes("\0"),
        ) ||
        !options.argv[0] ||
        Object.entries(options.env).some(
          ([key, value]) =>
            !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ||
            typeof value !== "string" ||
            value.includes("\0"),
        )
      ) {
        throw new HerdrAppError("invalid_start_options");
      }
      const terminal = { id: randomUUID() };
      const worker: Worker = {
        name: `pi-${randomUUID().replaceAll("-", "").slice(0, 29)}`,
        owner: randomUUID(),
        parent,
        launchUncertain: true,
      };
      // Keep the unique name/owner before launching, even if the reply is lost.
      this.workers.set(terminal.id, worker);
      let runReturned = false;
      const childEnv = Object.fromEntries(
        Object.entries({ ...this.env, ...options.env }).filter(
          (entry): entry is [string, string] =>
            entry[0] !== "HC_TERMINAL_ID" && entry[1] !== undefined,
        ),
      );
      try {
        const result = await this.rpc("terminal.run", {
          argv: [...options.argv],
          cwd: options.cwd,
          env: childEnv,
          name: worker.name,
          caller: parent,
          parent,
          no_notify: true,
          keep: false,
          rm: false,
          wait: false,
          labels: {
            [OWNER_LABEL]: worker.owner,
            "pi-kits.subagent.id": options.agentId,
            ...(options.agentType
              ? { "pi-kits.subagent.type": options.agentType }
              : {}),
          },
        });
        runReturned = true;
        worker.address = address(result.address);
        if (!(await this.facts(worker))) {
          throw new HerdrAppError("terminal_not_found_after_start");
        }
        return terminal;
      } catch (error) {
        if (
          !runReturned &&
          error instanceof HerdrAppError &&
          (error.requestRejected || error.code === "binary_unavailable")
        ) {
          this.workers.delete(terminal.id);
          throw error;
        }
        throw new TerminalStartError(terminal, error);
      }
    });
  }

  async inspect(terminal: TerminalHandle): Promise<{ alive: boolean }> {
    const facts = await this.facts(this.worker(terminal));
    return { alive: facts?.state === "live" };
  }

  destroy(terminal: TerminalHandle): Promise<void> {
    return this.serialize(async () => {
      const worker = this.worker(terminal);
      const before = await this.facts(worker);
      if (!before && worker.launchUncertain) {
        // A timed-out run may still create the uniquely named terminal later.
        // Retain cleanup responsibility rather than treating early absence as exit.
        throw new HerdrAppError("terminal_start_unconfirmed");
      }
      if (before?.state === "live") {
        try {
          await this.rpc("terminal.kill", { terminal: worker.address });
        } catch (error) {
          if (!notFound(error)) throw error;
        }
      }
      const after = await this.facts(worker);
      if (after?.state === "live") {
        throw new HerdrAppError("terminal_not_stopped");
      }
      if (after) {
        try {
          const result = await this.rpc("terminal.rm", {
            terminal: worker.address,
          });
          if (result.removed !== worker.address) {
            throw new HerdrAppError("invalid_response");
          }
        } catch (error) {
          if (!notFound(error)) throw error;
        }
      }
      this.workers.delete(terminal.id);
    });
  }

  private unsupported(operation: string): void {
    // A notification sink must never turn a warning-only operation into failure.
    try {
      this.warn(
        `Herdr app: ${operation} is unavailable for managed relative views; no window changes were made.`,
      );
    } catch {}
  }

  async open_view(options: OpenViewOptions): Promise<ViewHandle> {
    this.worker(options.terminal);
    // terminal.keep targets the current focus, not the requested parent/anchor.
    // Do not steal focus, create an unrelated pane, or pretend it was attached.
    this.unsupported("open_view");
    const view = { id: randomUUID() };
    this.views.add(view.id);
    return view;
  }

  async inspect_view(view: ViewHandle): Promise<{ alive: boolean }> {
    if (!this.views.has(view.id) && !this.closedViews.has(view.id)) {
      throw new HerdrAppError("unowned_view");
    }
    return { alive: false };
  }

  async focus_view(view: ViewHandle): Promise<void> {
    if (!this.views.has(view.id) && !this.closedViews.has(view.id)) {
      throw new HerdrAppError("unowned_view");
    }
    this.unsupported("focus_view");
  }

  async close_view(view: ViewHandle): Promise<void> {
    if (this.closedViews.has(view.id)) return;
    if (!this.views.has(view.id)) throw new HerdrAppError("unowned_view");
    this.unsupported("close_view");
    this.views.delete(view.id);
    this.closedViews.add(view.id);
  }
}

registerMux({
  id: "herdr-app",
  matches: (env) => Boolean(env.HC_TERMINAL_ID?.trim()),
  create: (options) => new HerdrAppAdapter(options),
});
