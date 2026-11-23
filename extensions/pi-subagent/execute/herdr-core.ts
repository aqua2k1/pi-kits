import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createSerializer } from "../util.ts";
import {
  buildChildEnv,
  createHandleTable,
  type Executor,
  ExecutorError,
  type OpenViewOptions,
  type TerminalHandle,
  type ViewHandle,
} from "./index.ts";

export interface HerdrCoreRunOptions {
  timeoutMs: number;
  maxOutputBytes: number;
  env: NodeJS.ProcessEnv;
  input: string;
}

export interface HerdrCoreRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type HerdrCoreRunner = (
  binary: string,
  argv: string[],
  options: HerdrCoreRunOptions,
) => Promise<HerdrCoreRunResult>;

export interface HerdrCoreOptions {
  runner?: HerdrCoreRunner;
  env?: NodeJS.ProcessEnv;
  binPath?: string;
  warn?: (message: string) => void;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export const runHerdrCore: HerdrCoreRunner = (binary, argv, options) =>
  new Promise((resolve, reject) => {
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
        if (error && typeof error.code !== "number") {
          const code =
            error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
              ? "output_limit"
              : error.killed
                ? "timeout"
                : error.code === "ENOENT" || error.code === "EACCES"
                  ? "binary_unavailable"
                  : "runner_failed";
          reject(new ExecutorError(code, error.message, { cause: error }));
          return;
        }
        resolve({
          exitCode: typeof error?.code === "number" ? error.code : 0,
          stdout,
          stderr,
        });
      },
    );
    child.stdin?.on("error", () => {});
    child.stdout?.on("data", (chunk: string) => {
      if (chunk.includes("\n")) child.stdin?.end();
    });
    child.stdin?.write(options.input);
  });

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ExecutorError("invalid_response");
  }
  return value as JsonObject;
}

function address(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ExecutorError("invalid_response");
  }
  return value;
}

function notFound(error: unknown): boolean {
  return error instanceof ExecutorError && error.code === "not_found";
}

function parseRpcReply(output: HerdrCoreRunResult): JsonObject {
  const summary = (s: string) => s.trim().slice(0, 512) || undefined;
  let reply: JsonObject;
  try {
    reply = object(JSON.parse(output.stdout));
  } catch (cause) {
    const code = output.exitCode === 0 ? "invalid_response" : "cli_failed";
    throw new ExecutorError(code, summary(output.stderr), { cause });
  }
  if ("error" in reply) {
    const err = object(reply.error);
    const data =
      err.data && typeof err.data === "object"
        ? (err.data as JsonObject)
        : undefined;
    const code =
      typeof data?.kind === "string" && data.kind ? data.kind : "server_error";
    const detail =
      typeof err.message === "string" ? summary(err.message) : undefined;
    throw new ExecutorError(code, detail);
  }
  if (output.exitCode !== 0) {
    throw new ExecutorError("cli_failed", summary(output.stderr));
  }
  return object(reply.result);
}

interface Worker {
  address: string;
  parent: string;
}

interface ViewAttachment {
  terminal: TerminalHandle;
  space: string;
  tab: string;
}

/** Herdr core (`hc`) executor: manages terminals and tab views purely via `hc` commands. */
export function createHerdrCoreExecutor(
  options: HerdrCoreOptions = {},
): Executor {
  const runner = options.runner ?? runHerdrCore;
  const env: NodeJS.ProcessEnv = { ...(options.env ?? process.env) };
  const binary = options.binPath ?? "hc";
  const warn = options.warn ?? console.warn;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const maxOutputBytes = options.maxOutputBytes ?? 1024 * 1024;

  const workers = createHandleTable<Worker>("unowned_terminal");
  const views = createHandleTable<ViewAttachment>("unowned_view");
  const closedViews = new Set<string>();
  const serialize = createSerializer();

  const checkEnv = (): boolean => Boolean(env.HC_TERMINAL_ID?.trim());

  const notify = (message: string): void => {
    try {
      warn(`Herdr core: ${message}`);
    } catch {}
  };

  const rpc = async (
    method: string,
    params: JsonObject,
  ): Promise<JsonObject> => {
    let output: HerdrCoreRunResult;
    try {
      output = await runner(binary, ["connect"], {
        timeoutMs,
        maxOutputBytes,
        env: { ...env },
        input: `${JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })}\n`,
      });
    } catch (error) {
      if (error instanceof ExecutorError) throw error;
      const detail = error instanceof Error ? error.message : String(error);
      throw new ExecutorError("runner_failed", detail, { cause: error });
    }
    return parseRpcReply(output);
  };

  const getWorkerInfo = async (
    worker: Worker,
  ): Promise<JsonObject | undefined> => {
    try {
      return await rpc("terminal.get", { terminal: worker.address });
    } catch (error) {
      if (notFound(error)) return undefined;
      throw error;
    }
  };

  const closeOwnedView = async (view: ViewHandle): Promise<void> => {
    if (closedViews.has(view.id)) return;
    const attachment = views.owned(view);
    const worker = workers.get(attachment.terminal);
    const info = worker && (await getWorkerInfo(worker));
    if (info && worker) {
      const labels = object(info.labels);
      if (
        labels["herdr.space"] === attachment.space &&
        labels["herdr.tab"] === attachment.tab
      ) {
        await rpc("terminal.label", {
          terminal: worker.address,
          labels: { "herdr.space": "", "herdr.tab": "" },
        });
        await rpc("terminal.keep", {
          terminal: worker.address,
          keep: false,
        });
      }
    }
    views.delete(view);
    closedViews.add(view.id);
  };

  return {
    id: "herdr-core",
    supportsView: true,
    check_env: checkEnv,
    start: (startOpts) =>
      serialize(async () => {
        if (!checkEnv()) throw new ExecutorError("not_in_herdr_core");
        const parent = address(env.HC_TERMINAL_ID);
        const result = await rpc("terminal.run", {
          argv: [...startOpts.argv],
          cwd: startOpts.cwd,
          env: buildChildEnv(env, startOpts.env, ["HC_TERMINAL_ID"]),
          name: `pi-${randomUUID().replaceAll("-", "").slice(0, 29)}`,
          caller: parent,
          parent,
          no_notify: true,
          keep: false,
          rm: false,
          wait: false,
          labels: {
            "pi-kits.subagent.id": startOpts.agentId,
            ...(startOpts.agentType
              ? { "pi-kits.subagent.type": startOpts.agentType }
              : {}),
          },
        });
        return workers.create({
          address: address(result.address),
          parent,
        });
      }),
    inspect: async (terminal) => {
      const current = await getWorkerInfo(workers.owned(terminal));
      return { alive: current?.state === "live" };
    },
    destroy: (terminal) =>
      serialize(async () => {
        const worker = workers.owned(terminal);
        try {
          await rpc("terminal.kill", { terminal: worker.address });
        } catch (error) {
          if (!notFound(error)) throw error;
        }
        try {
          await rpc("terminal.rm", { terminal: worker.address });
        } catch (error) {
          if (!notFound(error)) throw error;
        }
        workers.delete(terminal);
      }),
    open_view: (viewOpts: OpenViewOptions) =>
      serialize(async () => {
        const worker = workers.owned(viewOpts.terminal);
        if ((await getWorkerInfo(worker))?.state !== "live") {
          throw new ExecutorError("terminal_not_live");
        }
        const parent = await rpc("terminal.get", { terminal: worker.parent });
        const space = object(parent.labels)["herdr.space"];
        if (typeof space !== "string" || !space) {
          throw new ExecutorError("parent_space_unavailable");
        }
        const tab = `tb${randomUUID().replaceAll("-", "")}`;
        const view = views.create({ terminal: viewOpts.terminal, space, tab });
        try {
          await rpc("terminal.label", {
            terminal: worker.address,
            labels: { "herdr.space": space, "herdr.tab": tab },
          });
          await rpc("terminal.keep", {
            terminal: worker.address,
            keep: true,
          });
        } catch (error) {
          await closeOwnedView(view).catch(() => {});
          throw error;
        }
        notify(
          "Tab requested in the parent terminal's space; switch to it in your client.",
        );
        return view;
      }),
    inspect_view: async (view) => {
      if (closedViews.has(view.id)) return { alive: false };
      const attachment = views.owned(view);
      const worker = workers.get(attachment.terminal);
      if (!worker) return { alive: false };
      const info = await getWorkerInfo(worker);
      if (!info || info.state !== "live") return { alive: false };
      const labels = object(info.labels);
      return {
        alive:
          labels["herdr.space"] === attachment.space &&
          labels["herdr.tab"] === attachment.tab,
      };
    },
    focus_view: async (view) => {
      if (!views.get(view) && !closedViews.has(view.id)) {
        throw new ExecutorError("unowned_view");
      }
      notify("Focus is local to each client; switch to the task tab manually.");
    },
    close_view: (view) => serialize(() => closeOwnedView(view)),
  };
}
