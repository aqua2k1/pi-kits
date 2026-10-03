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
} from "./mux.ts";

export interface RunOptions {
  timeoutMs: number;
  maxOutputBytes: number;
}

export interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type HerdrRunner = (
  binary: string,
  argv: string[],
  options: RunOptions,
) => Promise<RunResult>;

export interface HerdrOptions {
  runner?: HerdrRunner;
  binPath?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

/** Never includes argv, worker env, CLI output, or echoed server messages. */
export class HerdrError extends Error {
  constructor(public readonly code: string) {
    super(`Herdr: ${code}`);
    this.name = "HerdrError";
  }
}

export const runHerdr: HerdrRunner = (binary, argv, options) =>
  new Promise((resolve, reject) => {
    execFile(
      binary,
      argv,
      {
        encoding: "utf8",
        shell: false,
        timeout: options.timeoutMs,
        maxBuffer: options.maxOutputBytes,
        killSignal: "SIGKILL",
      },
      (error, stdout, stderr) => {
        if (error && typeof error.code !== "number") {
          const code =
            error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
              ? "output_limit"
              : error.killed
                ? "timeout"
                : "runner_failed";
          reject(new HerdrError(code));
          return;
        }
        resolve({
          exitCode: typeof error?.code === "number" ? error.code : 0,
          stdout,
          stderr,
        });
      },
    );
  });

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HerdrError("invalid_response");
  }
  return value as JsonObject;
}

function identifier(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.startsWith("-") ||
    [...value].some((char) => {
      const code = char.charCodeAt(0);
      return code < 32 || code === 127;
    })
  ) {
    throw new HerdrError("invalid_response");
  }
  return value;
}

function json(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new HerdrError("invalid_response");
  }
}

function shellQuote(argv: string[]): string {
  return argv.map((arg) => `'${arg.replaceAll("'", `'"'"'`)}'`).join(" ");
}

interface Pane {
  paneId: string;
  terminalId: string;
  workspaceId: string;
}

function pane(value: unknown): Pane {
  const data = object(value);
  return {
    paneId: identifier(data.pane_id),
    terminalId: identifier(data.terminal_id),
    workspaceId: identifier(data.workspace_id),
  };
}

interface Worker {
  workspaceId: string;
  paneId?: string;
  terminalId?: string;
  cwd: string;
}

interface View extends Pane {
  workerId: string;
  anchor: string;
  direction: "right" | "down";
}

/**
 * CLI verified against Herdr 0.9.0 and https://herdr.dev/docs/cli-reference/.
 * Nested terminal attach was verified in an isolated, disposable workspace.
 * No server startup, pane move, takeover, or observe mode is performed.
 */
export class HerdrAdapter implements MuxAdapter {
  private readonly runner: HerdrRunner;
  private readonly binary: string;
  private readonly limits: RunOptions;
  private readonly workers = new Map<string, Worker>();
  private readonly views = new Map<string, View>();
  private mutation: Promise<void> = Promise.resolve();

  constructor(options: HerdrOptions = {}) {
    this.runner = options.runner ?? runHerdr;
    this.binary = options.binPath ?? process.env.HERDR_BIN_PATH ?? "herdr";
    this.limits = {
      timeoutMs: options.timeoutMs ?? 15_000,
      maxOutputBytes: options.maxOutputBytes ?? 1024 * 1024,
    };
    for (const limit of Object.values(this.limits)) {
      if (!Number.isSafeInteger(limit) || limit <= 0) {
        throw new HerdrError("invalid_limits");
      }
    }
  }

  // Serialize creation/destruction so shutdown cannot overtake an in-flight
  // split and leave its attachment behind. A failure never blocks later cleanup.
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutation.then(operation);
    this.mutation = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  check_env(): boolean {
    return process.env.HERDR_ENV === "1";
  }

  private async command(argv: string[], emptyOk = false): Promise<JsonObject> {
    if (!this.check_env()) throw new HerdrError("not_in_herdr");
    let output: RunResult;
    try {
      output = await this.runner(this.binary, argv, { ...this.limits });
    } catch (error) {
      // Even injected runners may include secrets in their thrown errors.
      throw error instanceof HerdrError
        ? error
        : new HerdrError("runner_failed");
    }
    if (
      Buffer.byteLength(output.stdout) + Buffer.byteLength(output.stderr) >
      this.limits.maxOutputBytes
    ) {
      throw new HerdrError("output_limit");
    }
    for (const text of [output.stdout, output.stderr]) {
      if (!text.trim().startsWith("{")) continue;
      const envelope = object(json(text));
      if ("error" in envelope) {
        const code = object(envelope.error).code;
        throw new HerdrError(
          typeof code === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(code)
            ? code
            : "server_error",
        );
      }
    }
    if (output.exitCode !== 0) throw new HerdrError("cli_failed");
    // Installed `pane run` succeeds with no output, unlike layout commands.
    if (emptyOk && !output.stdout.trim()) return {};
    return object(object(json(output.stdout)).result);
  }

  private worker(handle: TerminalHandle): Worker {
    const worker = this.workers.get(handle.id);
    if (!worker) throw new HerdrError("unowned_terminal");
    return worker;
  }

  private view(handle: ViewHandle): View {
    const view = this.views.get(handle.id);
    if (!view) throw new HerdrError("unowned_view");
    return view;
  }

  private async matches(expected: Pane): Promise<boolean> {
    try {
      const result = await this.command(["pane", "get", expected.paneId]);
      const actual = pane(result.pane);
      return (
        actual.paneId === expected.paneId &&
        actual.terminalId === expected.terminalId &&
        actual.workspaceId === expected.workspaceId
      );
    } catch (error) {
      if (error instanceof HerdrError && error.code === "not_found") {
        return false;
      }
      throw error;
    }
  }

  private workerPane(worker: Worker): Pane {
    return {
      paneId: identifier(worker.paneId),
      terminalId: identifier(worker.terminalId),
      workspaceId: worker.workspaceId,
    };
  }

  private async confirmStopped(worker: Worker): Promise<void> {
    if (!worker.paneId) throw new HerdrError("terminal_stop_unconfirmed");
    try {
      const result = await this.command(["pane", "get", worker.paneId]);
      pane(result.pane);
      // The old alias can resolve to a moved pane or a replacement terminal.
      // Neither is permission to close its new location or forget ownership.
      throw new HerdrError("terminal_not_stopped");
    } catch (error) {
      if (!(error instanceof HerdrError && error.code === "not_found")) {
        throw error;
      }
    }
    if (!worker.terminalId) throw new HerdrError("terminal_stop_unconfirmed");
    // A move may also invalidate the original alias. Check the terminal's
    // identity across the server rather than assuming not_found means exited.
    const result = await this.command(["pane", "list"]);
    if (!Array.isArray(result.panes)) throw new HerdrError("invalid_response");
    for (const value of result.panes) {
      const actual = pane(value);
      if (
        actual.terminalId === worker.terminalId ||
        actual.paneId === worker.paneId
      ) {
        throw new HerdrError("terminal_not_stopped");
      }
    }
  }

  private async closeWorkspace(worker: Worker): Promise<void> {
    let result: JsonObject;
    try {
      result = await this.command([
        "pane",
        "list",
        "--workspace",
        worker.workspaceId,
      ]);
    } catch (error) {
      if (!(error instanceof HerdrError && error.code === "not_found")) {
        throw error;
      }
      await this.confirmStopped(worker);
      return;
    }
    if (!Array.isArray(result.panes)) throw new HerdrError("invalid_response");
    // Refuse to kill any foreign pane moved/created in our workspace. Do not
    // use --group, or follow a moved worker into another workspace.
    for (const value of result.panes) {
      const actual = pane(value);
      if (
        actual.workspaceId !== worker.workspaceId ||
        actual.paneId !== worker.paneId ||
        (worker.terminalId && actual.terminalId !== worker.terminalId)
      ) {
        throw new HerdrError("workspace_contains_unowned_panes");
      }
    }
    if (result.panes.length) {
      // Recover a missing terminal ID only from the known root in the owned
      // workspace, never from a pane resolved in a foreign location.
      worker.terminalId ??= pane(result.panes[0]).terminalId;
      if (!(await this.matches(this.workerPane(worker)))) {
        throw new HerdrError("terminal_not_stopped");
      }
    } else {
      await this.confirmStopped(worker);
    }
    await this.command(["workspace", "close", worker.workspaceId]);
    // Closing the workspace can race a move, or succeed after it disappeared.
    // Keep the handle until the terminal's absence is actually confirmed.
    await this.confirmStopped(worker);
  }

  start(options: StartOptions): Promise<TerminalHandle> {
    return this.serialize(() => this.startWorker(options));
  }

  private async startWorker(options: StartOptions): Promise<TerminalHandle> {
    if (
      !options.agentId ||
      !isAbsolute(options.cwd) ||
      !options.argv.length ||
      !options.argv[0] ||
      [options.agentId, options.cwd, ...options.argv].some((s) =>
        s.includes("\0"),
      )
    ) {
      throw new HerdrError("invalid_start");
    }
    const argv = [
      "workspace",
      "create",
      "--cwd",
      options.cwd,
      "--label",
      `pi-subagent-${options.agentId}`,
      "--no-focus",
    ];
    for (const [key, value] of Object.entries(options.env)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || value.includes("\0")) {
        throw new HerdrError("invalid_env");
      }
      argv.push("--env", `${key}=${value}`);
    }
    const result = await this.command(argv);
    const worker: Worker = {
      workspaceId: identifier(object(result.workspace).workspace_id),
      cwd: options.cwd,
    };
    const handle = { id: randomUUID() };
    this.workers.set(handle.id, worker);
    try {
      // Capture the root ID before validating the remaining response so a
      // partial response can still be rolled back without touching outsiders.
      worker.paneId = identifier(object(result.root_pane).pane_id);
      const root = pane(result.root_pane);
      if (root.workspaceId !== worker.workspaceId) {
        worker.paneId = undefined;
        throw new HerdrError("invalid_response");
      }
      worker.terminalId = root.terminalId;
      // exec ties terminal lifetime to the supplied command, not a leftover
      // shell. The only shell text is a fixed prefix plus quoted argv.
      await this.command(
        ["pane", "run", root.paneId, `exec ${shellQuote(options.argv)}`],
        true,
      );
      return handle;
    } catch (error) {
      try {
        await this.closeWorkspace(worker);
      } catch (cleanupError) {
        throw new TerminalStartError(
          handle,
          new AggregateError([error, cleanupError], "Herdr start rollback"),
        );
      }
      this.workers.delete(handle.id);
      throw error;
    }
  }

  async inspect(terminal: TerminalHandle): Promise<{ alive: boolean }> {
    const worker = this.worker(terminal);
    return { alive: await this.matches(this.workerPane(worker)) };
  }

  destroy(terminal: TerminalHandle): Promise<void> {
    return this.serialize(() => this.destroyWorker(terminal));
  }

  private async destroyWorker(terminal: TerminalHandle): Promise<void> {
    const worker = this.worker(terminal);
    for (const [id, view] of this.views) {
      if (view.workerId === terminal.id) await this.closeView({ id });
    }
    await this.closeWorkspace(worker);
    this.workers.delete(terminal.id);
  }

  open_view(options: OpenViewOptions): Promise<ViewHandle> {
    return this.serialize(() => this.openView(options));
  }

  private async openView(options: OpenViewOptions): Promise<ViewHandle> {
    const worker = this.worker(options.terminal);
    if (options.direction !== "right" && options.direction !== "down") {
      throw new HerdrError("invalid_direction");
    }
    const anchor = process.env.HERDR_PANE_ID;
    if (!anchor) throw new HerdrError("missing_parent_pane");
    identifier(anchor);
    if (!(await this.matches(this.workerPane(worker)))) {
      throw new HerdrError("terminal_not_alive");
    }
    const parent = pane((await this.command(["pane", "get", anchor])).pane);
    const result = await this.command([
      "pane",
      "split",
      "--pane",
      anchor,
      "--direction",
      options.direction,
      "--cwd",
      worker.cwd,
      "--no-focus",
    ]);
    const attachment = pane(result.pane);
    if (
      attachment.paneId === anchor ||
      attachment.paneId === worker.paneId ||
      attachment.workspaceId !== parent.workspaceId
    ) {
      throw new HerdrError("invalid_response");
    }
    const handle = { id: randomUUID() };
    this.views.set(handle.id, {
      ...attachment,
      workerId: options.terminal.id,
      anchor,
      direction: options.direction,
    });
    try {
      await this.command(
        [
          "pane",
          "run",
          attachment.paneId,
          shellQuote([
            this.binary,
            "terminal",
            "attach",
            identifier(worker.terminalId),
          ]),
        ],
        true,
      );
      return handle;
    } catch (error) {
      try {
        await this.closeView(handle);
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "Herdr view rollback");
      }
      throw error;
    }
  }

  focus_view(handle: ViewHandle): Promise<void> {
    return this.serialize(() => this.focusView(handle));
  }

  private async focusView(handle: ViewHandle): Promise<void> {
    const view = this.view(handle);
    if (!(await this.matches(view))) throw new HerdrError("view_not_alive");
    const argv = ["--pane", view.anchor, "--direction", view.direction];
    const result = await this.command(["pane", "neighbor", ...argv]);
    if (object(result.neighbor).neighbor_pane_id !== view.paneId) {
      throw new HerdrError("view_layout_changed");
    }
    await this.command(["pane", "focus", ...argv]);
  }

  close_view(handle: ViewHandle): Promise<void> {
    return this.serialize(() => this.closeView(handle));
  }

  private async closeView(handle: ViewHandle): Promise<void> {
    const view = this.view(handle);
    if (await this.matches(view)) {
      await this.command(["pane", "close", view.paneId]);
    }
    this.views.delete(handle.id);
  }
}
