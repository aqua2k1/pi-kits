import { type ChildProcess, spawn } from "node:child_process";
import { createSerializer } from "../util.ts";
import {
  buildChildEnv,
  createHandleTable,
  type Executor,
  ExecutorError,
} from "./index.ts";

export type SubprocessSpawner = (
  command: string,
  args: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    detached: boolean;
  },
) => ChildProcess;

export interface SubprocessOptions {
  spawn?: SubprocessSpawner;
  env?: NodeJS.ProcessEnv;
  graceMs?: number;
}

interface OwnedProcess {
  child: ChildProcess;
  exited: boolean;
  exitPromise: Promise<void>;
}

const defaultSpawner: SubprocessSpawner = (command, args, options) =>
  spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    detached: options.detached,
    stdio: "ignore",
  });

function killProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid && process.platform !== "win32") {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
    }
  }
  try {
    child.kill(signal);
  } catch {}
}

/** Headless background process executor with POSIX process-group cleanup. */
export function createSubprocessExecutor(
  options: SubprocessOptions = {},
): Executor {
  const spawner = options.spawn ?? defaultSpawner;
  const baseEnv: NodeJS.ProcessEnv = { ...(options.env ?? process.env) };
  const graceMs = options.graceMs ?? 300;
  const processes = createHandleTable<OwnedProcess>("unowned_terminal");
  const serialize = createSerializer();

  return {
    id: "subprocess",
    supportsView: false,
    check_env: () => true,
    start: (startOpts) =>
      serialize(async () => {
        const [command, ...args] = startOpts.argv;
        const child = spawner(command, args, {
          cwd: startOpts.cwd,
          env: buildChildEnv(baseEnv, startOpts.env),
          detached: process.platform !== "win32",
        });
        let settled = false;
        const entry: OwnedProcess = {
          child,
          exited: child.exitCode !== null || child.signalCode !== null,
          exitPromise: new Promise<void>((resolve) => {
            const done = () => {
              if (settled) return;
              settled = true;
              entry.exited = true;
              resolve();
            };
            if (child.exitCode !== null || child.signalCode !== null) {
              done();
              return;
            }
            child.once("exit", done);
            child.once("close", done);
            child.once("error", done);
          }),
        };
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
              new ExecutorError("spawn_failed", error.message, {
                cause: error,
              }),
            );
          });
        });
        return processes.create(entry);
      }),
    inspect: async (terminal) => {
      const entry = processes.owned(terminal);
      return {
        alive:
          !entry.exited &&
          entry.child.exitCode === null &&
          entry.child.signalCode === null,
      };
    },
    destroy: (terminal) =>
      serialize(async () => {
        const entry = processes.owned(terminal);
        if (
          !entry.exited &&
          entry.child.exitCode === null &&
          entry.child.signalCode === null
        ) {
          killProcessTree(entry.child, "SIGTERM");
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([
              entry.exitPromise,
              new Promise<void>((resolve) => {
                timer = setTimeout(() => {
                  killProcessTree(entry.child, "SIGKILL");
                  resolve();
                }, graceMs);
              }),
            ]);
          } finally {
            clearTimeout(timer);
          }
        }
        processes.delete(terminal);
      }),
  };
}
