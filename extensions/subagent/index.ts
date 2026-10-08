import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  copyToClipboard,
  defineTool,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  readPiKitsConfig,
  SUBAGENT_DEFAULT_EXTENSIONS,
  type WorkerExtensionSource,
} from "@pi-kits/config";
import { Type } from "typebox";
import {
  DOCKED_PANEL_CLOSED,
  DOCKED_PANEL_OPENED,
} from "../../shared/ui/docked-panel/index.ts";
import { loadAgentDefinitions, resolveAgentDefinition } from "./agents.ts";
import { type AgentSnapshot, SubagentManager } from "./manager.ts";
import { HerdrAdapter } from "./mux/herdr.ts";
import type { MuxAdapter } from "./mux/index.ts";
import { codexReviewTargetSchema } from "./runtime/codex/schema.ts";
import {
  renderSubagentNotification,
  renderSubagentResult,
  renderSubagentTypesCall,
  renderSubagentTypesResult,
  subagentCallRenderer,
} from "./ui/renderers.ts";
import { SubagentStatusWidget } from "./ui/status-widget.ts";
import { showSubagentViews } from "./ui/views.ts";

const agentId = Type.String({ minLength: 1, description: "Subagent ID" });
const runtimeConfig = Type.Optional(
  Type.Object(
    { review_target: codexReviewTargetSchema() },
    {
      additionalProperties: true,
      description:
        "Options interpreted by the selected runtime. Session settings are fixed at launch; discover other options in agent configuration and runtime documentation.",
    },
  ),
);

function toolResult(snapshot: AgentSnapshot) {
  // Keep provenance and task/session metadata visible even when a long reply
  // exhausts the model-facing output budget.
  const { result, ...metadata } = snapshot;
  const text = JSON.stringify({ ...metadata, result }, null, 2);
  return {
    content: [
      {
        type: "text" as const,
        text:
          text.length > 24_000
            ? `${text.slice(0, 24_000)}\n[Truncated; open the subagent view or read its session file.]`
            : text,
      },
    ],
    details: snapshot,
  };
}

/** Register only after the selected adapter's side-effect-free env check. */
export function registerSubagents(
  pi: ExtensionAPI,
  adapter: MuxAdapter,
  maxConcurrent = 4,
  extensionAllowlist: readonly WorkerExtensionSource[] = SUBAGENT_DEFAULT_EXTENSIONS,
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
    manager ??= new SubagentManager(adapter, {
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
      status = new SubagentStatusWidget(manager, undefined, async (id) => {
        await current.openView(id);
      });
    }
    if (context?.mode === "tui") status.bind(context.ui);
    return manager;
  };

  pi.on("session_start", (_event, ctx) => {
    context = ctx;
    if (ctx.mode === "tui") status?.bind(ctx.ui);
  });

  pi.registerTool(
    defineTool({
      name: "subagent",
      label: "Subagent",
      renderCall: subagentCallRenderer("Subagent", (id) =>
        manager?.list().find((agent) => agent.id === id),
      ),
      renderResult: renderSubagentResult,
      description:
        "Delegate a task to an independent agent session. Background by default. Agent configuration takes precedence over call parameters. Use list_subagent_types to discover agents and resume_subagent for follow-up tasks.",
      parameters: Type.Object({
        subagent_type: Type.Optional(
          Type.String({
            minLength: 1,
            description:
              "Agent name from list_subagent_types; omit for an unnamed session.",
          }),
        ),
        runtime: Type.Optional(
          Type.String({
            minLength: 1,
            pattern: "\\S",
            description: "Execution runtime; omit to use the default.",
          }),
        ),
        prompt: Type.Optional(
          Type.String({
            minLength: 1,
            maxLength: 100_000,
            pattern: "\\S",
            description:
              "Task instructions, relevant context, and expected output; not a system prompt. Required unless the selected runtime accepts instructions through runtime_config.",
          }),
        ),
        cwd: Type.Optional(
          Type.String({
            minLength: 1,
            description:
              "Working directory; defaults to the parent working directory. Relative paths resolve against the parent directory. Must be an existing directory; retained on resume.",
          }),
        ),
        runtime_config: runtimeConfig,
        keep_alive: Type.Optional(
          Type.Boolean({
            default: false,
            description:
              "Keep the session after completion for later resume. Default false: release when no native view is open. Agent configuration takes precedence.",
          }),
        ),
        description: Type.String({
          minLength: 1,
          maxLength: 200,
          description: "Short task title for status displays.",
        }),
        model: Type.Optional(
          Type.String({
            minLength: 1,
            description: "Model identifier understood by the selected runtime.",
          }),
        ),
        thinking: Type.Optional(
          Type.String({
            minLength: 1,
            description:
              "Thinking or reasoning level understood by the selected runtime.",
          }),
        ),
        run_in_background: Type.Optional(
          Type.Boolean({
            default: true,
            description:
              "Return immediately with the task ID, or wait for completion when false.",
          }),
        ),
      }),
      async execute(_id, params, signal, _onUpdate, ctx) {
        signal?.throwIfAborted();
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
        const agent = params.subagent_type
          ? resolveAgentDefinition(ctx.cwd, params.subagent_type)
          : undefined;
        const runtime = agent?.runtime ?? params.runtime ?? "pi";
        const current = getManager(ctx);
        const snapshot = current.spawn({
          runtime,
          context: ctx.sessionManager,
          agent,
          keepAlive: params.keep_alive,
          prompt: params.prompt ?? "",
          runtimeParams: params.runtime_config,
          description: params.description,
          cwd,
          model:
            params.model ??
            (runtime === "pi" && ctx.model
              ? `${ctx.model.provider}/${ctx.model.id}`
              : undefined),
          thinking:
            params.thinking ??
            (runtime === "pi" ? pi.getThinkingLevel() : undefined),
        });
        if ((agent?.runInBackground ?? params.run_in_background) !== false) {
          return toolResult(snapshot);
        }
        return toolResult(await current.result(snapshot.id, true, signal));
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "resume_subagent",
      label: "Resume subagent",
      renderCall: subagentCallRenderer("Resume subagent", (id) =>
        manager?.list().find((agent) => agent.id === id),
      ),
      renderResult: renderSubagentResult,
      description:
        "Continue a finished task in the same session, retaining history and settings. Requires an idle, connected session. Background by default; the original agent configuration takes precedence.",
      parameters: Type.Object({
        agent_id: agentId,
        prompt: Type.Optional(
          Type.String({
            minLength: 1,
            maxLength: 100_000,
            pattern: "\\S",
            description:
              "Follow-up task instructions. Required unless the selected runtime accepts instructions through runtime_config.",
          }),
        ),
        runtime_config: runtimeConfig,
        description: Type.Optional(
          Type.String({
            minLength: 1,
            maxLength: 200,
            description:
              "New short task title; omit to retain the previous title.",
          }),
        ),
        run_in_background: Type.Optional(
          Type.Boolean({
            default: true,
            description:
              "Return immediately, or wait for completion when false.",
          }),
        ),
      }),
      async execute(_id, params, signal, _onUpdate, ctx) {
        signal?.throwIfAborted();
        const current = getManager(ctx);
        const snapshot = current.resume(params.agent_id, {
          prompt: params.prompt ?? "",
          runtimeParams: params.runtime_config,
          description: params.description,
        });
        if (
          (current.backgroundPreference(params.agent_id) ??
            params.run_in_background) !== false
        ) {
          return toolResult(snapshot);
        }
        return toolResult(await current.result(snapshot.id, true, signal));
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "list_subagent_types",
      label: "Subagent types",
      renderCall: renderSubagentTypesCall,
      renderResult: renderSubagentTypesResult,
      description:
        "List configured agents and their settings. Disabled agents are listed but cannot be started.",
      parameters: Type.Object({}),
      outputSchema: Type.Object({ agents: Type.Array(Type.Any()) }),
      async execute(_id, _params, _signal, _onUpdate, ctx) {
        const agents = [...loadAgentDefinitions(ctx.cwd).values()].map(
          ({ systemPrompt: _prompt, ...metadata }) => ({
            ...metadata,
            runtime: metadata.runtime ?? "pi",
          }),
        );
        const result = { agents };
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(result, null, 2) },
          ],
          details: result,
          // Raw runtime configuration comes from YAML; publish JSON-safe metadata.
          structuredContent: JSON.parse(JSON.stringify(result)),
        };
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "get_subagent_result",
      label: "Subagent result",
      renderCall: subagentCallRenderer("Subagent result", (id) =>
        manager?.list().find((agent) => agent.id === id),
      ),
      renderResult: renderSubagentResult,
      description:
        "Read managed task status and current session state, plus the latest settled reply (managed or user interaction) with its source, revision and update time.",
      parameters: Type.Object({
        agent_id: agentId,
        wait: Type.Optional(
          Type.Boolean({
            description:
              "Wait for the managed task to finish; otherwise return immediately.",
          }),
        ),
      }),
      async execute(_id, params, signal) {
        return toolResult(
          await getManager().result(params.agent_id, params.wait, signal),
        );
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "steer_subagent",
      label: "Steer subagent",
      renderCall: subagentCallRenderer("Steer subagent", (id) =>
        manager?.list().find((agent) => agent.id === id),
      ),
      renderResult: renderSubagentResult,
      description:
        "Send additional guidance to a running task. Use resume_subagent for a finished task.",
      parameters: Type.Object({
        agent_id: agentId,
        message: Type.String({
          minLength: 1,
          maxLength: 100_000,
          pattern: "\\S",
          description:
            "Additional instructions for the currently running task.",
        }),
      }),
      async execute(_id, params) {
        const current = getManager();
        await current.steer(params.agent_id, params.message);
        return toolResult(current.get(params.agent_id));
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "stop_subagent",
      label: "Stop subagent",
      renderCall: subagentCallRenderer("Stop subagent", (id) =>
        manager?.list().find((agent) => agent.id === id),
      ),
      renderResult: renderSubagentResult,
      description:
        "Cancel a queued or running managed task, not independent user interaction.",
      parameters: Type.Object({ agent_id: agentId }),
      async execute(_id, params) {
        return toolResult(getManager().stop(params.agent_id));
      },
    }),
  );

  pi.registerCommand("subagent:views", {
    description: "View/control a subagent: [id] [open|focus|close|copy|delete]",
    async handler(args, ctx) {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("Subagent views require interactive Pi.", "error");
        return;
      }
      try {
        const current = getManager(ctx);
        const tokens = args.trim().split(/\s+/).filter(Boolean);
        if (tokens.length > 2) {
          throw new Error(
            "Usage: /subagent:views [id] [open|focus|close|copy|delete]",
          );
        }
        let [id, action] = tokens;
        if (id) current.get(id);
        if (!action) {
          const instanceId = randomUUID();
          const payload = { panelId: "subagent:views", instanceId };
          const choice = await showSubagentViews(ctx.ui, current, id, {
            onOpen: () => pi.events.emit(DOCKED_PANEL_OPENED, payload),
            onClosed: (closeStatus) =>
              pi.events.emit(DOCKED_PANEL_CLOSED, {
                ...payload,
                status: closeStatus,
              }),
          });
          if (!choice) return;
          id = choice.agentId;
          action = choice.action;
        }
        if (!id) return;
        if (action === "copy") {
          await copyToClipboard(current.get(id).id);
          ctx.ui.notify("Copied subagent ID.", "info");
        } else if (action === "delete") {
          const agent = current.get(id);
          if (
            !(await ctx.ui.confirm(
              "Delete subagent?",
              `Delete ${agent.description} (${agent.id})? This closes its terminal and removes the manager record. Session files are retained.`,
            ))
          )
            return;
          await current.remove(id);
        } else if (action === "close") await current.closeView(id);
        else if (action === "open" || action === "focus") {
          await current.openView(id);
        } else {
          throw new Error(
            "View action must be open, focus, close, copy, or delete.",
          );
        }
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
      // Retry transient failures without abandoning ownership or keeping
      // shutdown alive indefinitely. Herdr identity checks remain unchanged.
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

export default function subagentExtension(pi: ExtensionAPI): void {
  // Workers inherit the mux environment but must not become coordinators.
  if (process.env.PI_KITS_SUBAGENT_WORKER === "1") return;
  const { subagent } = readPiKitsConfig();
  if (!subagent.enabled || subagent.mux !== "herdr") {
    return;
  }
  const adapter = new HerdrAdapter();
  if (!adapter.check_env()) return;
  registerSubagents(
    pi,
    adapter,
    subagent.maxConcurrent,
    subagent.extensionAllowlist,
  );
}
