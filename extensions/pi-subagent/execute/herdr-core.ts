import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  type AgentExecutionState,
  buildChildEnv,
  defineExecutor,
  type Executor,
  ExecutorError,
  type ExecutorFactoryOptions,
  type InspectResult,
  type SendCommandOptions,
  type StartOptions,
  type TerminalHandle,
  type ViewHandle,
} from "./index.ts";

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

function isExecutionState(value: unknown): value is AgentExecutionState {
  return (
    value === "idle" ||
    value === "working" ||
    value === "done" ||
    value === "blocked" ||
    value === "error"
  );
}

/** Pure function: checks whether the environment is inside a Herdr Core terminal. */
export function checkHerdrCoreEnv(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return Boolean(env.HC_TERMINAL_ID?.trim());
}

/** Pure function: builds the `terminal.run` JSON-RPC parameters for a subagent launch. */
export function buildHerdrRunParams(
  startOpts: StartOptions,
  baseEnv: NodeJS.ProcessEnv,
  name = `pi-${randomUUID().replaceAll("-", "").slice(0, 29)}`,
): JsonObject {
  if (!checkHerdrCoreEnv(baseEnv)) {
    throw new ExecutorError("not_in_herdr_core");
  }
  const parent = address(baseEnv.HC_TERMINAL_ID);
  return {
    argv: [...startOpts.argv],
    cwd: startOpts.cwd,
    env: buildChildEnv(baseEnv, startOpts.env, ["HC_TERMINAL_ID"]),
    name,
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
  };
}

/** Pure function: builds the `terminal.send` JSON-RPC parameters. */
export function buildHerdrSendParams(
  terminalId: string,
  text: string,
  caller: string | undefined,
  options?: SendCommandOptions,
): JsonObject {
  return {
    terminal: terminalId,
    ...(caller ? { caller } : {}),
    text,
    ...(options?.if ? { if: options.if } : {}),
  };
}

/** Pure function: parses a JSON-RPC reply from `hc connect` stdout/stderr. */
export function parseHerdrRpcReply(
  exitCode: number,
  stdout: string,
  stderr = "",
): JsonObject {
  const summary = (s: string) => s.trim().slice(0, 512) || undefined;
  let reply: JsonObject;
  try {
    reply = object(JSON.parse(stdout));
  } catch (cause) {
    const code = exitCode === 0 ? "invalid_response" : "cli_failed";
    throw new ExecutorError(code, summary(stderr), { cause });
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
  if (exitCode !== 0) {
    throw new ExecutorError("cli_failed", summary(stderr));
  }
  return object(reply.result);
}

/** Pure function: projects `terminal.get` facts (including OSC 7501 status) to `InspectResult`. */
export function parseHerdrTerminalStatus(
  info: JsonObject | undefined,
): InspectResult {
  if (!info || info.state !== "live") return { alive: false };
  const raw =
    info.status &&
    typeof info.status === "object" &&
    !Array.isArray(info.status)
      ? (info.status as JsonObject)
      : undefined;
  const state = isExecutionState(raw?.state)
    ? raw.state
    : isExecutionState(info.status)
      ? info.status
      : undefined;
  const message = typeof raw?.msg === "string" && raw.msg ? raw.msg : undefined;
  const kind = raw?.kind;
  const blockedKind =
    kind === "permission" || kind === "question" || kind === "auth"
      ? kind
      : undefined;
  const turn =
    typeof info.turn === "number" && Number.isSafeInteger(info.turn)
      ? info.turn
      : undefined;
  return {
    alive: true,
    ...(state ? { state } : {}),
    ...(turn !== undefined ? { turn } : {}),
    ...(message ? { message } : {}),
    ...(blockedKind ? { blockedKind } : {}),
  };
}

/** Pure function: checks whether a `terminal.get` payload still owns the given tab view. */
export function isHerdrViewAlive(
  info: JsonObject | undefined,
  view: ViewHandle,
): boolean {
  if (!info || info.state !== "live" || !view.space || !view.tab) return false;
  const labels = object(info.labels);
  return (
    labels["herdr.space"] === view.space && labels["herdr.tab"] === view.tab
  );
}

function callHcRpc(
  method: string,
  params: JsonObject,
  env: NodeJS.ProcessEnv,
  timeoutMs = 15_000,
): Promise<JsonObject> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "hc",
      ["connect"],
      {
        encoding: "utf8",
        shell: false,
        env,
        timeout: timeoutMs,
        maxBuffer: 1024 * 1024,
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
        try {
          const exitCode = typeof error?.code === "number" ? error.code : 0;
          resolve(parseHerdrRpcReply(exitCode, stdout, stderr));
        } catch (err) {
          reject(err);
        }
      },
    );
    child.stdin?.on("error", () => {});
    child.stdout?.on("data", (chunk: string) => {
      if (chunk.includes("\n")) child.stdin?.end();
    });
    child.stdin?.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })}\n`,
    );
  });
}

/** Stateless Herdr core (`hc`) executor. */
export function createHerdrCoreExecutor(
  options: ExecutorFactoryOptions = {},
): Executor {
  const env: NodeJS.ProcessEnv = { ...(options.env ?? process.env) };
  const warn = options.warn ?? console.warn;

  const notify = (message: string): void => {
    try {
      warn(`Herdr core: ${message}`);
    } catch {}
  };

  const getTerminalInfo = async (
    terminalAddress: string,
  ): Promise<JsonObject | undefined> => {
    try {
      return await callHcRpc(
        "terminal.get",
        { terminal: terminalAddress },
        env,
      );
    } catch (error) {
      if (notFound(error)) return undefined;
      throw error;
    }
  };

  return defineExecutor<TerminalHandle, ViewHandle>({
    id: "herdr-core",
    supportsView: true,
    check_env: () => checkHerdrCoreEnv(env),
    start: async (startOpts) => {
      const result = await callHcRpc(
        "terminal.run",
        buildHerdrRunParams(startOpts, env),
        env,
      );
      return {
        id: address(result.address),
        ...(startOpts.sessionPath
          ? { sessionPath: startOpts.sessionPath }
          : {}),
      };
    },
    inspect: async (terminal) =>
      parseHerdrTerminalStatus(await getTerminalInfo(terminal.id)),
    send: async (terminal, text, sendOpts) => {
      await callHcRpc(
        "terminal.send",
        buildHerdrSendParams(terminal.id, text, env.HC_TERMINAL_ID, sendOpts),
        env,
      );
    },
    wait: async (terminal, waitOpts) => {
      const timeout =
        waitOpts?.timeoutMs !== undefined
          ? Math.max(0.1, waitOpts.timeoutMs / 1000)
          : undefined;
      const res = await callHcRpc(
        "terminal.wait",
        {
          terminal: terminal.id,
          caller: env.HC_TERMINAL_ID,
          ...(timeout !== undefined ? { timeout } : {}),
        },
        env,
        Math.max(15_000, (waitOpts?.timeoutMs ?? 180_000) + 5_000),
      );
      if (res.reason === "exit") return { alive: false };
      const state = isExecutionState(res.status)
        ? res.status
        : res.reason === "timeout" || res.reason === "message"
          ? "working"
          : undefined;
      if (state === "error" || state === "blocked") {
        return parseHerdrTerminalStatus(await getTerminalInfo(terminal.id));
      }
      return {
        alive: true,
        ...(state ? { state } : {}),
        ...(typeof res.turn === "number" ? { turn: res.turn } : {}),
      };
    },
    interrupt: async (terminal) => {
      await callHcRpc(
        "terminal.interrupt",
        { terminal: terminal.id },
        env,
      ).catch((e) => {
        if (!notFound(e)) throw e;
      });
    },
    destroy: async (terminal) => {
      for (const method of ["terminal.kill", "terminal.rm"]) {
        await callHcRpc(method, { terminal: terminal.id }, env).catch((e) => {
          if (!notFound(e)) throw e;
        });
      }
    },
    open_view: async ({ terminal }) => {
      if ((await getTerminalInfo(terminal.id))?.state !== "live") {
        throw new ExecutorError("terminal_not_live");
      }
      const parent = await callHcRpc(
        "terminal.get",
        { terminal: address(env.HC_TERMINAL_ID) },
        env,
      );
      const space = object(parent.labels)["herdr.space"];
      if (typeof space !== "string" || !space) {
        throw new ExecutorError("parent_space_unavailable");
      }
      const tab = `tb${randomUUID().replaceAll("-", "")}`;
      await callHcRpc(
        "terminal.label",
        {
          terminal: terminal.id,
          labels: { "herdr.space": space, "herdr.tab": tab },
        },
        env,
      );
      await callHcRpc(
        "terminal.keep",
        { terminal: terminal.id, keep: true },
        env,
      );
      notify(
        "Tab requested in the parent terminal's space; switch to it in your client.",
      );
      return { id: tab, terminalId: terminal.id, space, tab };
    },
    inspect_view: async (view) => ({
      alive: view.terminalId
        ? isHerdrViewAlive(await getTerminalInfo(view.terminalId), view)
        : false,
    }),
    focus_view: async (view) => {
      if (!view.terminalId || !view.space || !view.tab) {
        throw new ExecutorError("unowned_view");
      }
      notify("Focus is local to each client; switch to the task tab manually.");
    },
    close_view: async (view) => {
      if (!view.terminalId || !view.space || !view.tab) return;
      const info = await getTerminalInfo(view.terminalId);
      if (isHerdrViewAlive(info, view)) {
        await callHcRpc(
          "terminal.label",
          {
            terminal: view.terminalId,
            labels: { "herdr.space": "", "herdr.tab": "" },
          },
          env,
        );
        await callHcRpc(
          "terminal.keep",
          { terminal: view.terminalId, keep: false },
          env,
        );
      }
    },
  });
}
