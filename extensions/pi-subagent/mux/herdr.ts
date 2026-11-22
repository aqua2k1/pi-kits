import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { createSerializer } from "../util.ts";
import {
  type MuxAdapter,
  type OpenViewOptions,
  type StartOptions,
  type TerminalHandle,
  TerminalStartError,
  type ViewHandle,
} from "./index.ts";

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
  env?: NodeJS.ProcessEnv;
  binPath?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export class HerdrError extends Error {
  constructor(
    public readonly code: string,
    detail?: string,
    options?: ErrorOptions,
  ) {
    super(detail ? `Herdr (${code}): ${detail}` : `Herdr: ${code}`, options);
    this.name = "HerdrError";
  }
}

function isNotFound(error: unknown): boolean {
  return (
    error instanceof HerdrError &&
    ["not_found", "pane_not_found", "workspace_not_found"].includes(error.code)
  );
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
          reject(new HerdrError(code, error.message, { cause: error }));
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
  if (typeof value !== "string" || !value.trim()) {
    throw new HerdrError("invalid_response");
  }
  return value;
}

function summary(text: string): string | undefined {
  const trimmed = text.trim();
  return trimmed ? trimmed.slice(0, 512) : undefined;
}

function json(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw new HerdrError("invalid_response", summary(text), { cause });
  }
}

function shellQuote(argv: string[]): string {
  return argv.map((arg) => `'${arg.replaceAll("'", `'"'"'`)}'`).join(" ");
}

function parseCommandOutput(output: RunResult, emptyOk: boolean): JsonObject {
  for (const text of [output.stdout, output.stderr]) {
    if (!text.trim().startsWith("{")) continue;
    const envelope = object(json(text));
    if ("error" in envelope) {
      const err = object(envelope.error);
      const code =
        typeof err.code === "string" && err.code ? err.code : "server_error";
      const detail =
        typeof err.message === "string" ? summary(err.message) : undefined;
      throw new HerdrError(code, detail);
    }
  }
  if (output.exitCode !== 0) {
    throw new HerdrError("cli_failed", summary(output.stderr));
  }
  // Installed `pane run` succeeds with no output, unlike layout commands.
  if (emptyOk && !output.stdout.trim()) return {};
  return object(object(json(output.stdout)).result);
}

function buildWorkspaceCreateArgv(options: StartOptions): string[] {
  if (
    !options.agentId ||
    !isAbsolute(options.cwd) ||
    !options.argv.length ||
    !options.argv[0]
  ) {
    throw new HerdrError("invalid_start");
  }
  const argv = [
    "workspace",
    "create",
    "--cwd",
    options.cwd,
    "--label",
    `sub-${options.agentType ?? "anonymous"}-${options.agentId}`,
    "--no-focus",
  ];
  for (const [key, value] of Object.entries(options.env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || value.includes("\0")) {
      throw new HerdrError("invalid_env");
    }
    argv.push("--env", `${key}=${value}`);
  }
  return argv;
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
  paneId: string;
  terminalId: string;
  cwd: string;
}

interface View extends Pane {
  workerId: string;
  parent: Pane;
  anchor: Pane;
  direction: "right" | "down";
}

/** Legacy Herdr 0.9 CLI adapter with right-then-down column view layout. */
export function createHerdrAdapter(options: HerdrOptions = {}): MuxAdapter {
  const runner = options.runner ?? runHerdr;
  const pinnedEnv = options.env ? { ...options.env } : undefined;
  const currentEnv = () => pinnedEnv ?? process.env;
  const binary = options.binPath ?? currentEnv().HERDR_BIN_PATH ?? "herdr";
  const limits: RunOptions = {
    timeoutMs: options.timeoutMs ?? 15_000,
    maxOutputBytes: options.maxOutputBytes ?? 1024 * 1024,
  };

  const workers = new Map<string, Worker>();
  const views = new Map<string, View>();
  const closedViews = new Set<string>();
  const serialize = createSerializer();

  const checkEnv = (): boolean => currentEnv().HERDR_ENV === "1";

  const command = async (
    argv: string[],
    emptyOk = false,
  ): Promise<JsonObject> => {
    if (!checkEnv()) throw new HerdrError("not_in_herdr");
    let output: RunResult;
    try {
      output = await runner(binary, argv, { ...limits });
    } catch (error) {
      if (error instanceof HerdrError) throw error;
      const detail = error instanceof Error ? error.message : String(error);
      throw new HerdrError("runner_failed", detail, { cause: error });
    }
    return parseCommandOutput(output, emptyOk);
  };

  const ownedWorker = (handle: TerminalHandle): Worker => {
    const found = workers.get(handle.id);
    if (!found) throw new HerdrError("unowned_terminal");
    return found;
  };

  const ownedView = (handle: ViewHandle): View => {
    const found = views.get(handle.id);
    if (!found) throw new HerdrError("unowned_view");
    return found;
  };

  const matches = async (expected: Pane): Promise<boolean> => {
    try {
      const result = await command(["pane", "get", expected.paneId]);
      const actual = pane(result.pane);
      return (
        actual.paneId === expected.paneId &&
        actual.terminalId === expected.terminalId &&
        actual.workspaceId === expected.workspaceId
      );
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }
  };

  const closeWorkspace = async (worker: Worker): Promise<void> => {
    let result: JsonObject;
    try {
      result = await command([
        "pane",
        "list",
        "--workspace",
        worker.workspaceId,
      ]);
    } catch (error) {
      if (isNotFound(error)) return;
      throw error;
    }
    if (!Array.isArray(result.panes)) throw new HerdrError("invalid_response");
    // Do not close a workspace if the user added another pane to it.
    for (const value of result.panes) {
      const actual = pane(value);
      if (
        actual.workspaceId !== worker.workspaceId ||
        actual.paneId !== worker.paneId ||
        actual.terminalId !== worker.terminalId
      ) {
        throw new HerdrError("workspace_contains_unowned_panes");
      }
    }
    try {
      await command(["workspace", "close", worker.workspaceId]);
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  };

  const closeView = async (handle: ViewHandle): Promise<void> => {
    if (closedViews.has(handle.id)) return;
    const view = ownedView(handle);
    if (await matches(view)) {
      await command(["pane", "close", view.paneId]);
    }
    views.delete(handle.id);
    closedViews.add(handle.id);
  };

  const startWorker = async (
    startOpts: StartOptions,
  ): Promise<TerminalHandle> => {
    const argv = buildWorkspaceCreateArgv(startOpts);
    const result = await command(argv);
    const workspaceId = identifier(object(result.workspace).workspace_id);
    const root = pane(result.root_pane);
    const worker: Worker = {
      workspaceId,
      paneId: root.paneId,
      terminalId: root.terminalId,
      cwd: startOpts.cwd,
    };
    const handle = { id: randomUUID() };
    workers.set(handle.id, worker);
    try {
      // exec ties terminal lifetime to the supplied command, not a leftover shell.
      await command(
        ["pane", "run", root.paneId, `exec ${shellQuote(startOpts.argv)}`],
        true,
      );
      return handle;
    } catch (error) {
      try {
        await closeWorkspace(worker);
      } catch (cleanupError) {
        throw new TerminalStartError(
          handle,
          new AggregateError([error, cleanupError], "Herdr start rollback"),
        );
      }
      workers.delete(handle.id);
      throw error;
    }
  };

  const destroyWorker = async (terminal: TerminalHandle): Promise<void> => {
    const worker = ownedWorker(terminal);
    for (const [id, view] of views) {
      if (view.workerId === terminal.id) await closeView({ id });
    }
    await closeWorkspace(worker);
    workers.delete(terminal.id);
  };

  const openView = async (viewOpts: OpenViewOptions): Promise<ViewHandle> => {
    const worker = ownedWorker(viewOpts.terminal);
    const parentId = currentEnv().HERDR_PANE_ID;
    if (!parentId) throw new HerdrError("missing_parent_pane");
    if (!(await matches(worker))) {
      throw new HerdrError("terminal_not_alive");
    }
    const parent = pane((await command(["pane", "get", parentId])).pane);
    // Place the first attachment right of the parent and stack subsequent ones
    // below the last surviving owned attachment in the parent's workspace.
    let relativeView: View | undefined;
    for (const [id, candidate] of [...views.entries()].reverse()) {
      if (!(await matches(candidate))) {
        views.delete(id);
        closedViews.add(id);
        continue;
      }
      if (candidate.workspaceId === parent.workspaceId) {
        relativeView = candidate;
        break;
      }
    }
    const anchor: Pane = relativeView ?? parent;
    const direction = relativeView ? "down" : "right";
    const result = await command([
      "pane",
      "split",
      "--pane",
      anchor.paneId,
      "--direction",
      direction,
      "--cwd",
      worker.cwd,
      "--no-focus",
    ]);
    const attachment = pane(result.pane);
    const handle = { id: randomUUID() };
    views.set(handle.id, {
      ...attachment,
      workerId: viewOpts.terminal.id,
      parent,
      anchor: {
        paneId: anchor.paneId,
        terminalId: anchor.terminalId,
        workspaceId: anchor.workspaceId,
      },
      direction,
    });
    try {
      await command(
        [
          "pane",
          "run",
          attachment.paneId,
          shellQuote([binary, "terminal", "attach", worker.terminalId]),
        ],
        true,
      );
      return handle;
    } catch (error) {
      try {
        await closeView(handle);
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "Herdr view rollback");
      }
      throw error;
    }
  };

  const focusView = async (handle: ViewHandle): Promise<void> => {
    const view = ownedView(handle);
    if (!(await matches(view))) throw new HerdrError("view_not_alive");
    const routes = [
      { anchor: view.anchor, direction: view.direction },
      ...[view.parent, ...views.values()].flatMap((anchor) =>
        ["right", "down", "up", "left"].map((direction) => ({
          anchor,
          direction,
        })),
      ),
    ];
    for (const route of routes) {
      if (
        route.anchor.paneId === view.paneId ||
        route.anchor.workspaceId !== view.workspaceId
      ) {
        continue;
      }
      const argv = [
        "--pane",
        route.anchor.paneId,
        "--direction",
        route.direction,
      ];
      let result: JsonObject;
      try {
        result = await command(["pane", "neighbor", ...argv]);
      } catch (error) {
        if (isNotFound(error)) continue;
        throw error;
      }
      if (object(result.neighbor).neighbor_pane_id === view.paneId) {
        await command(["pane", "focus", ...argv]);
        return;
      }
    }
    throw new HerdrError("view_layout_changed");
  };

  return {
    id: "herdr",
    check_env: checkEnv,
    start: (startOpts) => serialize(() => startWorker(startOpts)),
    inspect: async (terminal) => ({
      alive: await matches(ownedWorker(terminal)),
    }),
    destroy: (terminal) => serialize(() => destroyWorker(terminal)),
    open_view: (viewOpts) => serialize(() => openView(viewOpts)),
    inspect_view: async (handle) =>
      closedViews.has(handle.id)
        ? { alive: false }
        : { alive: await matches(ownedView(handle)) },
    focus_view: (handle) => serialize(() => focusView(handle)),
    close_view: (handle) => serialize(() => closeView(handle)),
  };
}
