import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  buildChildEnv,
  defineExecutor,
  type Executor,
  ExecutorError,
  type ExecutorFactoryOptions,
  type InspectResult,
  type SendCommandOptions,
  type TerminalHandle,
} from "./index.ts";

interface SubprocessHandle extends TerminalHandle {
  readonly child: ChildProcess;
}

function killProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid && process.platform !== "win32") {
    try {
      process.kill(-child.pid, signal);
    } catch {}
  }
  try {
    child.kill(signal);
  } catch {}
}

function isChildAlive(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}

function requireChild(terminal: SubprocessHandle): ChildProcess {
  if (!terminal || typeof terminal.child !== "object" || !terminal.child) {
    throw new ExecutorError("unowned_terminal");
  }
  return terminal.child;
}

/** Pure function: formats an outbound Pi RPC JSONL command frame for `send`. */
export function formatRpcSendCommand(
  text: string,
  options?: SendCommandOptions,
): string {
  const cmd =
    options?.if === "working"
      ? { type: "steer", message: text }
      : { type: "prompt", message: text, streamingBehavior: "followUp" };
  return `${JSON.stringify(cmd)}\n`;
}

/**
 * Pure function: inspects a single Pi RPC JSONL stdout line.
 * Returns a terminal `InspectResult` when the turn settles or fails preflight,
 * or `undefined` if the turn is still in progress.
 */
export function parseRpcSettlementLine(
  line: string,
  alive = true,
): InspectResult | undefined {
  if (!line.trim()) return undefined;
  try {
    const ev = JSON.parse(line) as Record<string, unknown>;
    if (
      ev.type === "response" &&
      ev.command === "prompt" &&
      ev.success === false
    ) {
      return {
        alive,
        state: "error",
        ...(typeof ev.error === "string" ? { message: ev.error } : {}),
      };
    }
    if (ev.type === "agent_settled") {
      const aborted = ev.aborted === true || ev.outcome === "aborted";
      return {
        alive,
        state: aborted ? "idle" : ev.outcome === "error" ? "error" : "done",
      };
    }
  } catch {}
  return undefined;
}

/**
 * Stateless headless background process executor using `pi --mode rpc` over stdio JSONL.
 */
export function createSubprocessExecutor(
  options: ExecutorFactoryOptions = {},
): Executor {
  const baseEnv: NodeJS.ProcessEnv = { ...(options.env ?? process.env) };

  return defineExecutor<SubprocessHandle>({
    id: "subprocess",
    supportsView: false,
    check_env: () => true,
    start: async (startOpts) => {
      const [command, ...args] = startOpts.argv;
      const child = spawn(command, args, {
        cwd: startOpts.cwd,
        env: buildChildEnv(baseEnv, startOpts.env),
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "ignore"],
      });
      child.stdin?.on("error", () => {});
      await new Promise<void>((resolve, reject) => {
        if (child.pid !== undefined) {
          child.unref?.();
          resolve();
          return;
        }
        child.once("spawn", () => {
          child.unref?.();
          resolve();
        });
        child.once("error", (error) => {
          reject(
            new ExecutorError("spawn_failed", error.message, { cause: error }),
          );
        });
      });
      return {
        id: `pid-${child.pid ?? randomUUID()}`,
        ...(startOpts.sessionPath
          ? { sessionPath: startOpts.sessionPath }
          : {}),
        child,
      };
    },
    inspect: async (terminal) => ({
      alive: isChildAlive(requireChild(terminal)),
    }),
    send: async (terminal, text, sendOpts) => {
      const child = requireChild(terminal);
      if (!isChildAlive(child)) throw new ExecutorError("terminal_not_live");
      child.stdin?.write(formatRpcSendCommand(text, sendOpts));
    },
    wait: async (terminal, waitOpts) => {
      const child = requireChild(terminal);
      if (!isChildAlive(child)) return { alive: false };
      return new Promise<InspectResult>((resolve) => {
        let buf = "";
        let timer: ReturnType<typeof setTimeout> | undefined;
        const finish = (result: InspectResult) => {
          if (timer) clearTimeout(timer);
          child.stdout?.off("data", onData);
          child.off("exit", onExit);
          child.off("close", onExit);
          child.off("error", onExit);
          resolve(result);
        };
        const onExit = () => finish({ alive: false });
        const onData = (chunk: Buffer | string) => {
          buf += chunk.toString("utf8");
          for (let nl = buf.indexOf("\n"); nl !== -1; nl = buf.indexOf("\n")) {
            const line = buf.slice(0, nl).replace(/\r$/, "");
            buf = buf.slice(nl + 1);
            const settled = parseRpcSettlementLine(line, isChildAlive(child));
            if (settled) {
              finish(settled);
              return;
            }
          }
        };
        child.stdout?.on("data", onData);
        child.once("exit", onExit);
        child.once("close", onExit);
        child.once("error", onExit);
        if (waitOpts?.timeoutMs !== undefined) {
          timer = setTimeout(
            () => finish({ alive: isChildAlive(child), state: "working" }),
            waitOpts.timeoutMs,
          );
        }
      });
    },
    interrupt: async (terminal) => {
      const child = requireChild(terminal);
      if (isChildAlive(child)) {
        child.stdin?.write(`${JSON.stringify({ type: "abort" })}\n`);
      }
    },
    destroy: async (terminal) => {
      const child = requireChild(terminal);
      if (!isChildAlive(child)) return;
      const exitPromise = new Promise<void>((resolve) => {
        child.once("exit", () => resolve());
        child.once("close", () => resolve());
        child.once("error", () => resolve());
      });
      killProcessTree(child, "SIGTERM");
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          exitPromise,
          new Promise<void>((resolve) => {
            timer = setTimeout(() => {
              killProcessTree(child, "SIGKILL");
              resolve();
            }, 300);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    },
  });
}
