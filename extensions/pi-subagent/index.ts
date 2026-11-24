import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  defineTool,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  DOCKED_PANEL_CLOSED,
  DOCKED_PANEL_OPENED,
} from "../../shared/ui/docked-panel/index.ts";
import {
  formatAgentParameterDescription,
  formatAvailableAgents,
  resolveAgentDefinition,
  SUBAGENT_DEFAULT_EXTENSIONS,
  type WorkerExtensionSource,
} from "./config.ts";
import type { Executor } from "./execute/index.ts";
import { resolveExecutor } from "./execute/resolve.ts";
import {
  type AgentSnapshot,
  createSubagentManager,
  type SubagentManager,
} from "./manager.ts";
import {
  renderSubagentNotification,
  renderSubagentResult,
  subagentCallRenderer,
} from "./ui/renderers.ts";
import {
  createSubagentStatusWidget,
  type SubagentStatusWidget,
} from "./ui/status-widget.ts";
import { showSubagentViews, type ViewActionResult } from "./ui/views.ts";

const namespace = {
  name: "pi-subagent",
  description:
    "Delegate tasks to independent agent sessions and manage their lifecycle and results.",
};

const BASE_SUBAGENT_DESCRIPTION =
  "Send a task to an independent subagent session. Omit `id` to start a new session; provide `id` to steer a running session or resume a finished one (automatically restarting from its saved session file if the worker was released).";

function toolResult(snapshot: AgentSnapshot) {
  const payload = {
    id: snapshot.id,
    description: snapshot.description,
    ...(snapshot.subagentType ? { subagentType: snapshot.subagentType } : {}),
    ...(snapshot.cwd ? { cwd: snapshot.cwd } : {}),
    status: snapshot.status,
    ...(snapshot.round !== undefined ? { round: snapshot.round } : {}),
    ...(snapshot.sessionState ? { sessionState: snapshot.sessionState } : {}),
    ...(snapshot.activity ? { activity: snapshot.activity } : {}),
    ...(snapshot.sessionActivity
      ? { sessionActivity: snapshot.sessionActivity }
      : {}),
    ...(snapshot.error ? { error: snapshot.error } : {}),
    ...(snapshot.truncated ? { truncated: true } : {}),
    ...(snapshot.sessionPath ? { sessionPath: snapshot.sessionPath } : {}),
    ...(snapshot.hint ? { hint: snapshot.hint } : {}),
    ...(snapshot.result !== undefined ? { result: snapshot.result } : {}),
  };
  const text = JSON.stringify(payload, null, 2);
  return {
    content: [
      {
        type: "text" as const,
        text:
          text.length > 24_000
            ? `${text.slice(0, 24_000)}\n[Truncated; read the full session file at ${snapshot.sessionPath ?? "sessionPath"}.]`
            : text,
      },
    ],
    details: snapshot,
  };
}

export function registerSubagents(
  pi: ExtensionAPI,
  executor: Executor,
  maxConcurrent = 4,
  extensionAllowlist: readonly WorkerExtensionSource[] = SUBAGENT_DEFAULT_EXTENSIONS,
  createManager: typeof createSubagentManager = createSubagentManager,
): void {
  pi.registerMessageRenderer(
    "subagent-notification",
    renderSubagentNotification,
  );
  let manager: SubagentManager | undefined;
  let status: SubagentStatusWidget | undefined;
  let context: ExtensionContext | undefined;
  let shutdown: Promise<void> | undefined;

  const getManager = (ctx?: ExtensionContext) => {
    if (shutdown) throw new Error("Subagent manager is shutting down.");
    context = ctx ?? context;
    manager ??= createManager(executor, {
      maxConcurrent,
      extensionAllowlist,
      onSessionUpdate(snapshot, update) {
        pi.sendMessage(
          {
            customType: "subagent-notification",
            content: [
              {
                type: "text",
                text: `Subagent user interaction ${update.outcome}. ${update.response ? "Latest reply updated; managed task status/round/statistics are unchanged." : "No new reply; the previous result is retained."}${update.error ? ` Error: ${update.error}` : ""}`,
              },
              ...toolResult(snapshot).content,
            ],
            display: true,
            details: {
              ...snapshot,
              sessionUpdate: {
                interactionId: update.interactionId,
                outcome: update.outcome,
                hasReply: Boolean(update.response),
                error: update.error,
              },
            },
          },
          { triggerTurn: false },
        );
      },
      onComplete(snapshot) {
        pi.sendMessage(
          {
            customType: "subagent-notification",
            content: toolResult(snapshot).content,
            display: true,
            details: snapshot,
          },
          { triggerTurn: true, deliverAs: "followUp" },
        );
      },
    });
    if (!status) {
      const current = manager;
      status = createSubagentStatusWidget(manager, undefined, async (id) => {
        await current.openView(id);
      });
    }
    if (context?.mode === "tui") status.bind(context.ui);
    return manager;
  };

  const agentParameter: ReturnType<
    typeof Type.Optional<ReturnType<typeof Type.String>>
  > & {
    description?: string;
  } = Type.Optional(
    Type.String({
      minLength: 1,
      description: formatAgentParameterDescription(process.cwd()),
    }),
  );

  pi.on("session_start", (_event, ctx) => {
    context = ctx;
    agentParameter.description = formatAgentParameterDescription(ctx.cwd);
    if (ctx.mode === "tui") status?.bind(ctx.ui);
  });

  pi.registerTool(
    defineTool({
      name: "subagent",
      namespace,
      label: "Subagent",
      renderCall: subagentCallRenderer("Subagent", (id) =>
        manager?.list().find((agent) => agent.id === id),
      ),
      renderResult: renderSubagentResult,
      description: BASE_SUBAGENT_DESCRIPTION,
      prepareLoadout() {
        const currentCwd = context?.cwd ?? process.cwd();
        agentParameter.description =
          formatAgentParameterDescription(currentCwd);
        const suffix = formatAvailableAgents(currentCwd);
        return suffix
          ? {
              descriptions: {
                subagent: `${BASE_SUBAGENT_DESCRIPTION}${suffix}`,
              },
            }
          : undefined;
      },
      parameters: Type.Object({
        prompt: Type.String({
          minLength: 1,
          maxLength: 100_000,
          pattern: "\\S",
          description:
            "Task instructions, follow-up request, or steering guidance; not a system prompt.",
        }),
        id: Type.Optional(
          Type.String({
            minLength: 1,
            description:
              "Existing subagent ID (e.g. 'sub-1') to steer or resume. Omit to start a new session.",
          }),
        ),
        agent: agentParameter,
        description: Type.Optional(
          Type.String({
            minLength: 1,
            maxLength: 200,
            description:
              "Short task title for status displays; defaults to a summary of the prompt.",
          }),
        ),
        cwd: Type.Optional(
          Type.String({
            minLength: 1,
            description:
              "Working directory for a new session; defaults to the parent working directory. Relative paths resolve against the parent directory.",
          }),
        ),
        background: Type.Optional(
          Type.Boolean({
            default: true,
            description:
              "Return immediately with the subagent ID (default true), or wait for completion when false. Agent configuration takes precedence.",
          }),
        ),
      }),
      async execute(_id, params, signal, _onUpdate, ctx) {
        signal?.throwIfAborted();
        const current = getManager(ctx);
        if (params.id) {
          const snapshot = await current.send(params.id, {
            prompt: params.prompt,
            description: params.description,
          });
          const runInBackground =
            current.backgroundPreference(params.id) ?? params.background;
          if (runInBackground !== false || snapshot.status === "running") {
            return toolResult(snapshot);
          }
          return toolResult(await current.result(snapshot.id, true, signal));
        }

        const cwd = resolve(ctx.cwd, params.cwd ?? ".");
        try {
          if (!statSync(cwd).isDirectory()) {
            throw new Error("Not a directory.");
          }
        } catch (cause) {
          throw new Error(
            `Invalid subagent cwd: ${cwd}. Must be an existing directory.`,
            { cause },
          );
        }
        const agent = params.agent
          ? resolveAgentDefinition(ctx.cwd, params.agent)
          : undefined;
        const snapshot = current.spawn({
          context: ctx.sessionManager,
          agent,
          prompt: params.prompt,
          description: params.description,
          cwd,
          model:
            agent?.model ??
            (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined),
          thinking: agent?.thinking ?? pi.getThinkingLevel(),
        });
        if ((agent?.runInBackground ?? params.background) !== false) {
          return toolResult(snapshot);
        }
        return toolResult(await current.result(snapshot.id, true, signal));
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "subagent_ctl",
      namespace,
      label: "Subagent control",
      renderCall: subagentCallRenderer("Subagent control", (id) =>
        manager?.list().find((agent) => agent.id === id),
      ),
      renderResult: renderSubagentResult,
      description:
        "Control or inspect an existing subagent session by ID: 'wait' until the active round finishes, check 'status' immediately, or 'stop' the queued/running round.",
      parameters: Type.Object({
        id: Type.String({
          minLength: 1,
          description: "Target subagent ID (e.g. 'sub-1').",
        }),
        action: Type.Union(
          [Type.Literal("wait"), Type.Literal("status"), Type.Literal("stop")],
          {
            description:
              "Control action: 'wait' blocks until completion and returns the result; 'status' returns current state immediately; 'stop' cancels the active round.",
          },
        ),
      }),
      async execute(_id, params, signal) {
        const current = getManager();
        if (params.action === "stop") {
          return toolResult(current.stop(params.id));
        }
        return toolResult(
          await current.result(params.id, params.action === "wait", signal),
        );
      },
    }),
  );

  pi.registerCommand("subagent:views", {
    description: "Inspect and control subagents and their terminal views",
    async handler(args, ctx) {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("Subagent views require interactive Pi.", "error");
        return;
      }
      try {
        const current = getManager(ctx);
        const initialId = args.trim() || undefined;
        if (initialId) current.get(initialId);
        const payload = { panelId: "subagent:views", instanceId: randomUUID() };
        await showSubagentViews(
          ctx.ui,
          current,
          async ({ agentId, action }): Promise<ViewActionResult> => {
            switch (action) {
              case "open":
              case "focus":
                await current.openView(agentId);
                return { closePanel: true };
              case "close":
                await current.closeView(agentId);
                return {};
              case "stop":
                current.stop(agentId);
                return {};
              case "delete":
                await current.remove(agentId);
                return {};
            }
          },
          initialId,
          {
            onOpen: () => pi.events.emit(DOCKED_PANEL_OPENED, payload),
            onClosed: (closeStatus) =>
              pi.events.emit(DOCKED_PANEL_CLOSED, {
                ...payload,
                status: closeStatus,
              }),
          },
        );
      } catch (error) {
        ctx.ui.notify(
          error instanceof Error ? error.message : String(error),
          "error",
        );
      }
    },
  });

  pi.on("session_shutdown", () => {
    if (shutdown) return shutdown;
    const current = manager;
    status?.dispose();
    status = undefined;
    context = undefined;
    if (!current) return;
    shutdown = (async () => {
      for (let attempt = 0; ; attempt++) {
        try {
          await current.close();
          break;
        } catch (error) {
          if (attempt === 2) throw error;
          await delay(100 * (attempt + 1));
        }
      }
      if (manager === current) manager = undefined;
    })().finally(() => {
      shutdown = undefined;
    });
    return shutdown;
  });
}

export interface SubagentExtensionDependencies {
  resolveExecutor?: typeof resolveExecutor;
  createManager?: typeof createSubagentManager;
}

export default function subagentExtension(
  pi: ExtensionAPI,
  dependencies: SubagentExtensionDependencies = {},
): void {
  // Workers inherit the host environment but must not become coordinators.
  if (process.env.PI_KITS_SUBAGENT_WORKER === "1") return;

  let context: ExtensionContext | undefined;
  const warnings: string[] = [];
  const warn = (message: string) => {
    if (!context) {
      warnings.push(message);
      return;
    }
    try {
      context.ui.notify(message, "warning");
    } catch {}
  };
  const resolveExec = dependencies.resolveExecutor ?? resolveExecutor;
  const executor = resolveExec(process.env, { warn });
  pi.on("session_start", (_event, ctx) => {
    context = ctx;
    for (const message of warnings.splice(0)) warn(message);
  });
  pi.on("session_shutdown", () => {
    context = undefined;
    warnings.length = 0;
  });
  registerSubagents(
    pi,
    executor,
    4,
    SUBAGENT_DEFAULT_EXTENSIONS,
    dependencies.createManager,
  );
}
