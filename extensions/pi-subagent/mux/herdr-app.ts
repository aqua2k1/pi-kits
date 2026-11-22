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

export class HerdrAppError extends Error {
  constructor(
    public readonly code: string,
    public readonly requestRejected = false,
    detail?: string,
    options?: ErrorOptions,
  ) {
    super(
      detail ? `Herdr app (${code}): ${detail}` : `Herdr app: ${code}`,
      options,
    );
    this.name = "HerdrAppError";
  }
}

/** Keep stdin open until the reply arrives; EOF before it can lose a launch reply. */
export const runHerdrApp: HerdrAppRunner = (binary, argv, options) =>
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
          reject(
            new HerdrAppError(code, false, error.message, { cause: error }),
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
    child.stdin?.on("error", () => {});
    child.stdout?.on("data", (chunk: string) => {
      if (chunk.includes("\n")) child.stdin?.end();
    });
    child.stdin?.write(options.input);
  });

type JsonObject = Record<string, unknown>;
const OWNER_LABEL = "pi-kits.subagent.owner";
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
  if (typeof value !== "string" || !value.trim()) {
    throw new HerdrAppError("invalid_response");
  }
  return value;
}

function notFound(error: unknown): boolean {
  return error instanceof HerdrAppError && error.code === "not_found";
}

function summary(text: string): string | undefined {
  const trimmed = text.trim();
  return trimmed ? trimmed.slice(0, 512) : undefined;
}

function parseRpcReply(output: HerdrAppRunResult): JsonObject {
  let reply: JsonObject;
  try {
    reply = object(JSON.parse(output.stdout));
  } catch (cause) {
    const code = output.exitCode === 0 ? "invalid_response" : "cli_failed";
    throw new HerdrAppError(code, false, summary(output.stderr), { cause });
  }
  if ("error" in reply) {
    const error = object(reply.error);
    const data =
      error.data && typeof error.data === "object"
        ? (error.data as JsonObject)
        : undefined;
    const code =
      typeof data?.kind === "string" && data.kind ? data.kind : "server_error";
    const detail =
      typeof error.message === "string" ? summary(error.message) : undefined;
    throw new HerdrAppError(code, LAUNCH_REJECTED_CODES.has(code), detail);
  }
  if (output.exitCode !== 0) {
    throw new HerdrAppError("cli_failed", false, summary(output.stderr));
  }
  return object(reply.result);
}

function validateStartOptions(options: StartOptions): void {
  if (
    !isAbsolute(options.cwd) ||
    !options.argv.length ||
    !options.argv[0] ||
    options.argv.some((arg) => arg.includes("\0")) ||
    Object.entries(options.env).some(
      ([key, value]) =>
        !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || value.includes("\0"),
    )
  ) {
    throw new HerdrAppError("invalid_start_options");
  }
}

function findTab(
  value: JsonObject,
  spaceId: string,
  tabId: string,
): JsonObject | undefined {
  for (const entry of value.spaces as unknown[]) {
    const space = object(entry);
    if (space.id !== spaceId) continue;
    if (!Array.isArray(space.tabs)) throw new HerdrAppError("invalid_response");
    return space.tabs.map(object).find((tab) => tab.id === tabId);
  }
  return undefined;
}

function treeContainsTerminal(node: JsonObject, terminal: string): boolean {
  if (node.content && object(node.content).terminal === terminal) return true;
  if (
    Array.isArray(node.floating) &&
    node.floating.some((entry) => treeContainsTerminal(object(entry), terminal))
  )
    return true;
  return (
    Array.isArray(node.children) &&
    node.children.some((entry) => treeContainsTerminal(object(entry), terminal))
  );
}

/** Pure removal of only the owned terminal, preserving sibling panes and unknown fields. */
function removeTerminalFromTree(
  node: JsonObject,
  terminal: string,
): JsonObject | undefined {
  if (node.content && object(node.content).terminal === terminal) {
    if (Array.isArray(node.floating) && node.floating.length) {
      throw new HerdrAppError("view_layout_changed");
    }
    return undefined;
  }
  const next: JsonObject = { ...node };
  if (Array.isArray(node.floating)) {
    next.floating = node.floating.filter(
      (entry) => object(object(entry).content).terminal !== terminal,
    );
  }
  if (Array.isArray(node.children)) {
    const children = node.children.flatMap((entry) => {
      const child = removeTerminalFromTree(object(entry), terminal);
      return child ? [child] : [];
    });
    const floating = next.floating;
    if (!children.length && !(Array.isArray(floating) && floating.length)) {
      return undefined;
    }
    next.children = children;
    if (
      next.type === "stack" &&
      typeof next.active === "string" &&
      !children.some((child) => child.id === next.active)
    ) {
      next.active = children[0]?.id ?? null;
    }
  }
  return next;
}

function removeTerminalFromLayout(
  value: JsonObject,
  spaceId: string,
  tabId: string,
  terminal: string,
): JsonObject | undefined {
  const tab = findTab(value, spaceId, tabId);
  if (!tab || !treeContainsTerminal(object(tab.root), terminal)) {
    return undefined;
  }
  const root = removeTerminalFromTree(object(tab.root), terminal);
  return {
    ...value,
    spaces: (value.spaces as unknown[]).map((entry) => {
      const space = object(entry);
      if (space.id !== spaceId) return space;
      const tabs = (space.tabs as unknown[]).flatMap((tabEntry) => {
        const candidate = object(tabEntry);
        if (candidate.id !== tabId) return [candidate];
        return root ? [{ ...candidate, root }] : [];
      });
      return { ...space, tabs };
    }),
  };
}

interface Worker {
  name: string;
  owner: string;
  parent: string;
  address?: string;
}

interface ViewAttachment {
  terminal: TerminalHandle;
  address: string;
  space: string;
  tab: string;
  pending: boolean;
  closing: boolean;
  requestFailed: boolean;
}

/**
 * The Herdr app integration owns hc terminals, not the user's app or core.
 * hc connect's JSON-line API preserves argv/env without shell interpolation.
 */
export function createHerdrAppAdapter(
  options: HerdrAppOptions = {},
): MuxAdapter {
  const runner = options.runner ?? runHerdrApp;
  const env: NodeJS.ProcessEnv = { ...(options.env ?? process.env) };
  const binary = options.binPath ?? "hc";
  const warn = options.warn ?? console.warn;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const maxOutputBytes = options.maxOutputBytes ?? 1024 * 1024;

  const workers = new Map<string, Worker>();
  const views = new Map<string, ViewAttachment>();
  const closedViews = new Set<string>();
  const serialize = createSerializer();

  const checkEnv = (): boolean => Boolean(env.HC_TERMINAL_ID?.trim());

  const notify = (message: string): void => {
    try {
      warn(`Herdr app: ${message}`);
    } catch {}
  };

  const rpc = async (
    method: string,
    params: JsonObject,
  ): Promise<JsonObject> => {
    let output: HerdrAppRunResult;
    try {
      output = await runner(binary, ["connect"], {
        timeoutMs,
        maxOutputBytes,
        env: { ...env },
        input: `${JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })}\n`,
      });
    } catch (error) {
      if (error instanceof HerdrAppError) throw error;
      const detail = error instanceof Error ? error.message : String(error);
      throw new HerdrAppError("runner_failed", false, detail, { cause: error });
    }
    return parseRpcReply(output);
  };

  const ownedWorker = (handle: TerminalHandle): Worker => {
    const found = workers.get(handle.id);
    if (!found) throw new HerdrAppError("unowned_terminal");
    return found;
  };

  const getWorkerInfo = async (
    worker: Worker,
  ): Promise<JsonObject | undefined> => {
    let result: JsonObject;
    try {
      result = await rpc("terminal.get", {
        terminal: worker.address ?? worker.name,
      });
    } catch (error) {
      if (notFound(error)) return undefined;
      throw error;
    }
    // Recovering a timed-out launch by name verifies our ownership label once.
    if (!worker.address) {
      if (object(result.labels)[OWNER_LABEL] !== worker.owner) {
        throw new HerdrAppError("terminal_identity_changed");
      }
      worker.address = address(result.address);
    }
    return result;
  };

  const layout = async (): Promise<{ value: JsonObject; version: number }> => {
    const result = await rpc("doc.get", { name: "herdr-app" });
    const value = result.value === null ? { spaces: [] } : object(result.value);
    if (!Array.isArray(value.spaces)) {
      throw new HerdrAppError("invalid_response");
    }
    return { value, version: result.version as number };
  };

  const closeOwnedView = async (view: ViewHandle): Promise<void> => {
    if (closedViews.has(view.id)) return;
    const attachment = views.get(view.id);
    if (!attachment) throw new HerdrAppError("unowned_view");
    const worker = workers.get(attachment.terminal.id);
    const info = worker && (await getWorkerInfo(worker));
    if (info) {
      const labels = object(info.labels);
      const owned =
        labels["herdr.space"] === attachment.space &&
        labels["herdr.tab"] === attachment.tab;
      const cleared = !labels["herdr.space"] && !labels["herdr.tab"];
      // Never follow a placement moved to another tab/space by the user.
      if (!owned && !(attachment.closing && cleared)) {
        views.delete(view.id);
        closedViews.add(view.id);
        return;
      }
      attachment.closing = true;
      await rpc("terminal.label", {
        terminal: attachment.address,
        labels: { "herdr.space": "", "herdr.tab": "" },
      });
      await rpc("terminal.keep", {
        terminal: attachment.address,
        keep: false,
      });
    }
    for (let attempt = 0; ; attempt++) {
      const { value, version } = await layout();
      const updated = removeTerminalFromLayout(
        value,
        attachment.space,
        attachment.tab,
        attachment.address,
      );
      if (!updated) break;
      try {
        await rpc("doc.set", { name: "herdr-app", version, value: updated });
        break;
      } catch (error) {
        if (
          !(error instanceof HerdrAppError) ||
          error.code !== "conflict" ||
          attempt >= 2
        ) {
          throw error;
        }
      }
    }
    views.delete(view.id);
    closedViews.add(view.id);
  };

  return {
    id: "herdr-app",
    check_env: checkEnv,
    start: (startOpts) =>
      serialize(async () => {
        if (!checkEnv()) throw new HerdrAppError("not_in_herdr_app");
        const parent = address(env.HC_TERMINAL_ID);
        validateStartOptions(startOpts);
        const terminal = { id: randomUUID() };
        const worker: Worker = {
          name: `pi-${randomUUID().replaceAll("-", "").slice(0, 29)}`,
          owner: randomUUID(),
          parent,
        };
        // Record name/owner before launching so a timed-out reply stays cleanable.
        workers.set(terminal.id, worker);
        const childEnv = Object.fromEntries(
          Object.entries({ ...env, ...startOpts.env }).filter(
            (entry): entry is [string, string] =>
              entry[0] !== "HC_TERMINAL_ID" && entry[1] !== undefined,
          ),
        );
        try {
          const result = await rpc("terminal.run", {
            argv: [...startOpts.argv],
            cwd: startOpts.cwd,
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
              "pi-kits.subagent.id": startOpts.agentId,
              ...(startOpts.agentType
                ? { "pi-kits.subagent.type": startOpts.agentType }
                : {}),
            },
          });
          worker.address = address(result.address);
          return terminal;
        } catch (error) {
          if (
            error instanceof HerdrAppError &&
            (error.requestRejected || error.code === "binary_unavailable")
          ) {
            workers.delete(terminal.id);
            throw error;
          }
          throw new TerminalStartError(terminal, error);
        }
      }),
    inspect: async (terminal) => {
      const current = await getWorkerInfo(ownedWorker(terminal));
      return { alive: current?.state === "live" };
    },
    destroy: (terminal) =>
      serialize(async () => {
        const worker = ownedWorker(terminal);
        if (!worker.address) {
          const recovered = await getWorkerInfo(worker);
          if (!recovered) {
            throw new HerdrAppError("terminal_start_unconfirmed");
          }
        }
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
        workers.delete(terminal.id);
      }),
    open_view: (viewOpts: OpenViewOptions) =>
      serialize(async () => {
        const worker = ownedWorker(viewOpts.terminal);
        for (const [id, attachment] of views) {
          if (
            attachment.terminal.id === viewOpts.terminal.id &&
            attachment.requestFailed
          ) {
            await closeOwnedView({ id });
          }
        }
        if ((await getWorkerInfo(worker))?.state !== "live") {
          throw new HerdrAppError("terminal_not_live");
        }
        const parent = await rpc("terminal.get", { terminal: worker.parent });
        const space = object(parent.labels)["herdr.space"];
        if (typeof space !== "string" || !space) {
          throw new HerdrAppError("parent_space_unavailable");
        }
        const view = { id: randomUUID() };
        const tab = `tb${randomUUID().replaceAll("-", "")}`;
        views.set(view.id, {
          terminal: viewOpts.terminal,
          address: address(worker.address),
          space,
          tab,
          pending: true,
          closing: false,
          requestFailed: true,
        });
        try {
          await rpc("terminal.label", {
            terminal: worker.address,
            labels: { "herdr.space": space, "herdr.tab": tab },
          });
          await rpc("terminal.keep", {
            terminal: worker.address,
            keep: true,
          });
          const attachment = views.get(view.id);
          if (attachment) attachment.requestFailed = false;
        } catch (error) {
          await closeOwnedView(view).catch(() => {});
          throw error;
        }
        notify(
          "Tab requested in the parent terminal's space; switch to it in your client. Attachment is asynchronous.",
        );
        return view;
      }),
    inspect_view: async (view) => {
      if (closedViews.has(view.id)) return { alive: false };
      const attachment = views.get(view.id);
      if (!attachment) throw new HerdrAppError("unowned_view");
      const worker = workers.get(attachment.terminal.id);
      if (!worker) return { alive: false };
      const info = await getWorkerInfo(worker);
      if (!info || info.state !== "live") return { alive: false };
      const labels = object(info.labels);
      if (
        labels["herdr.space"] !== attachment.space ||
        labels["herdr.tab"] !== attachment.tab
      ) {
        return { alive: false };
      }
      const { value } = await layout();
      const tab = findTab(value, attachment.space, attachment.tab);
      if (
        tab &&
        treeContainsTerminal(object(tab.root), worker.address as string)
      ) {
        attachment.pending = false;
        return { alive: true };
      }
      // Do not report closed before the client publishes the requested tab.
      if (attachment.pending)
        throw new HerdrAppError("view_change_unconfirmed");
      return { alive: false };
    },
    focus_view: async (view) => {
      if (!views.has(view.id) && !closedViews.has(view.id)) {
        throw new HerdrAppError("unowned_view");
      }
      notify("Focus is local to each client; switch to the task tab manually.");
    },
    close_view: (view) => serialize(() => closeOwnedView(view)),
  };
}
