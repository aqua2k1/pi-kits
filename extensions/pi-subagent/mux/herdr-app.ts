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
  "conflict",
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

function parseRpcReply(
  output: HerdrAppRunResult,
  maxOutputBytes: number,
): JsonObject {
  if (
    Buffer.byteLength(output.stdout) + Buffer.byteLength(output.stderr) >
    maxOutputBytes
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

function validateStartOptions(options: StartOptions): void {
  if (
    !isAbsolute(options.cwd) ||
    !options.argv.length ||
    options.argv.some((arg) => typeof arg !== "string" || arg.includes("\0")) ||
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
  launchUncertain: boolean;
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
  // Pin the core session and inherited environment for this adapter's handles.
  const env: NodeJS.ProcessEnv = { ...(options.env ?? process.env) };
  const binary = options.binPath ?? "hc";
  const warn = options.warn ?? console.warn;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const maxOutputBytes = options.maxOutputBytes ?? 1024 * 1024;
  for (const value of [timeoutMs, maxOutputBytes]) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new HerdrAppError("invalid_limits");
    }
  }

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
      throw error instanceof HerdrAppError
        ? error
        : new HerdrAppError("runner_failed");
    }
    return parseRpcReply(output, maxOutputBytes);
  };

  const ownedWorker = (handle: TerminalHandle): Worker => {
    const found = workers.get(handle.id);
    if (!found) throw new HerdrAppError("unowned_terminal");
    return found;
  };

  const facts = async (worker: Worker): Promise<JsonObject | undefined> => {
    let result: JsonObject;
    try {
      result = await rpc("terminal.get", {
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
  };

  const layout = async (): Promise<{ value: JsonObject; version: number }> => {
    const result = await rpc("doc.get", { name: "herdr-app" });
    if (
      !Number.isSafeInteger(result.version) ||
      (result.version as number) < 0
    ) {
      throw new HerdrAppError("invalid_response");
    }
    const value = result.value === null ? { spaces: [] } : object(result.value);
    if (!Array.isArray(value.spaces))
      throw new HerdrAppError("invalid_response");
    return { value, version: result.version as number };
  };

  const closeOwnedView = async (view: ViewHandle): Promise<void> => {
    if (closedViews.has(view.id)) return;
    const attachment = views.get(view.id);
    if (!attachment) throw new HerdrAppError("unowned_view");
    const worker = workers.get(attachment.terminal.id);
    const workerFacts = worker && (await facts(worker));
    if (workerFacts) {
      const labels = object(workerFacts.labels);
      const owned =
        labels["herdr.space"] === attachment.space &&
        labels["herdr.tab"] === attachment.tab;
      const cleared = !labels["herdr.space"] && !labels["herdr.tab"];
      // Never follow a placement changed by a person or another client.
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
    // Runtime teardown may precede this call (or a cleanup retry). The immutable
    // address and original placement still identify our stale document entry.
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
        const result = await rpc("doc.set", {
          name: "herdr-app",
          version,
          value: updated,
        });
        if (!Number.isSafeInteger(result.version))
          throw new HerdrAppError("invalid_response");
        break;
      } catch (error) {
        if (
          !(error instanceof HerdrAppError) ||
          error.code !== "conflict" ||
          attempt >= 2
        )
          throw error;
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
          launchUncertain: true,
        };
        // Keep the unique name/owner before launching, even if the reply is lost.
        workers.set(terminal.id, worker);
        let runReturned = false;
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
          runReturned = true;
          worker.address = address(result.address);
          if (!(await facts(worker))) {
            throw new HerdrAppError("terminal_not_found_after_start");
          }
          return terminal;
        } catch (error) {
          if (
            !runReturned &&
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
      const current = await facts(ownedWorker(terminal));
      return { alive: current?.state === "live" };
    },
    destroy: (terminal) =>
      serialize(async () => {
        const worker = ownedWorker(terminal);
        const before = await facts(worker);
        if (!before && worker.launchUncertain) {
          // A timed-out run may still create the uniquely named terminal later.
          // Retain cleanup responsibility rather than treating early absence as exit.
          throw new HerdrAppError("terminal_start_unconfirmed");
        }
        if (before?.state === "live") {
          try {
            await rpc("terminal.kill", { terminal: worker.address });
          } catch (error) {
            if (!notFound(error)) throw error;
          }
        }
        const after = await facts(worker);
        if (after?.state === "live") {
          throw new HerdrAppError("terminal_not_stopped");
        }
        if (after) {
          try {
            const result = await rpc("terminal.rm", {
              terminal: worker.address,
            });
            if (result.removed !== worker.address) {
              throw new HerdrAppError("invalid_response");
            }
          } catch (error) {
            if (!notFound(error)) throw error;
          }
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
        if ((await facts(worker))?.state !== "live")
          throw new HerdrAppError("terminal_not_live");
        const parent = await rpc("terminal.get", { terminal: worker.parent });
        if (address(parent.address) !== worker.parent)
          throw new HerdrAppError("terminal_identity_changed");
        const space = object(parent.labels)["herdr.space"];
        if (typeof space !== "string" || !space)
          throw new HerdrAppError("parent_space_unavailable");
        const view = { id: randomUUID() };
        const tab = `tb${randomUUID().replaceAll("-", "")}`;
        // Record partial requests so destroy/retry never loses ownership.
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
          // A lost reply can still have changed labels/keep. Undo only our own
          // request; if cleanup fails, retain it for the next open or destroy.
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
      const workerFacts = await facts(worker);
      if (!workerFacts || workerFacts.state !== "live") return { alive: false };
      const labels = object(workerFacts.labels);
      if (
        labels["herdr.space"] !== attachment.space ||
        labels["herdr.tab"] !== attachment.tab
      )
        return { alive: false };
      const { value } = await layout();
      const tab = findTab(value, attachment.space, attachment.tab);
      if (
        tab &&
        treeContainsTerminal(object(tab.root), worker.address as string)
      ) {
        attachment.pending = false;
        return { alive: true };
      }
      // Labels/keep acknowledge a request, not a pane: do not release the worker
      // or claim a live view before a client has published its shared layout.
      if (attachment.pending)
        throw new HerdrAppError("view_change_unconfirmed");
      return { alive: false };
    },
    focus_view: async (view) => {
      if (!views.has(view.id) && !closedViews.has(view.id))
        throw new HerdrAppError("unowned_view");
      notify("Focus is local to each client; switch to the task tab manually.");
    },
    close_view: (view) => serialize(() => closeOwnedView(view)),
  };
}
