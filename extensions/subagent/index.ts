import { randomUUID } from "node:crypto";
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
import { captureParentSession } from "./clone.ts";
import { HerdrAdapter } from "./herdr.ts";
import { type AgentSnapshot, SubagentManager } from "./manager.ts";
import type { MuxAdapter } from "./mux.ts";
import {
  renderSubagentNotification,
  renderSubagentResult,
  renderSubagentTypesCall,
  renderSubagentTypesResult,
  subagentCallRenderer,
} from "./renderers.ts";
import { SubagentStatusWidget } from "./status-widget.ts";
import { showSubagentViews } from "./views.ts";

const agentId = Type.String({ minLength: 1, description: "Subagent ID" });

function toolResult(snapshot: AgentSnapshot) {
  const text = JSON.stringify(snapshot, null, 2);
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
  const getManager = (ctx?: ExtensionContext) => {
    context = ctx ?? context;
    manager ??= new SubagentManager(adapter, {
      maxConcurrent,
      extensionAllowlist,
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
    status ??= new SubagentStatusWidget(manager);
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
        "Run a task in an independent Pi or Codex runtime with Herdr native views. Background by default. Pi supports cloning the parent branch; cross-runtime context inheritance is rejected. Frontmatter is authoritative. Select a user-defined subagent_type or runtime (default pi); use list_subagent_types to discover names. Agent configuration takes precedence. Pi workers share filesystem access; Codex uses its own sandbox/approval policy. Codex native views require a finished task and must be exited before managed continuation. Use /subagent:views for native terminal control.",
      parameters: Type.Object({
        subagent_type: Type.Optional(Type.String({ minLength: 1 })),
        runtime: Type.Optional(Type.String({ minLength: 1, pattern: "\\S" })),
        inherit_context: Type.Optional(Type.Boolean({ default: false })),
        prompt: Type.String({
          minLength: 1,
          maxLength: 100_000,
          pattern: "\\S",
        }),
        description: Type.String({ minLength: 1, maxLength: 200 }),
        model: Type.Optional(Type.String({ minLength: 1 })),
        thinking: Type.Optional(
          Type.String({
            minLength: 1,
            description:
              "Runtime-native thinking level: Pi thinking or Codex reasoning effort. Parent defaults apply only to Pi.",
          }),
        ),
        run_in_background: Type.Optional(Type.Boolean({ default: true })),
      }),
      async execute(_id, params, signal, _onUpdate, ctx) {
        signal?.throwIfAborted();
        const agent = params.subagent_type
          ? resolveAgentDefinition(ctx.cwd, params.subagent_type)
          : undefined;
        const runtime = agent?.runtime ?? params.runtime ?? "pi";
        const inheritContext =
          agent?.inheritContext ?? params.inherit_context ?? false;
        if (runtime !== "pi" && inheritContext) {
          throw new Error(
            "Cross-runtime context cloning is unsupported; Codex must start fresh.",
          );
        }
        const current = getManager(ctx);
        const snapshot = current.spawn({
          runtime,
          parentSession: inheritContext
            ? captureParentSession(ctx.sessionManager)
            : undefined,
          agent,
          prompt: params.prompt,
          description: params.description,
          cwd: ctx.cwd,
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
        "Continue a finished managed task in the same retained runtime session/history without restarting. Re-enters the shared concurrency queue. Requires idle sessionState; rejects native/user interaction, closed or disconnected sessions. Codex native TUI must be exited first; detaching its view is not enough. Retains original instructions and current runtime settings. Background by default, respecting original agent configuration.",
      parameters: Type.Object({
        agent_id: agentId,
        prompt: Type.String({
          minLength: 1,
          maxLength: 100_000,
          pattern: "\\S",
        }),
        description: Type.Optional(
          Type.String({ minLength: 1, maxLength: 200 }),
        ),
        run_in_background: Type.Optional(Type.Boolean({ default: true })),
      }),
      async execute(_id, params, signal, _onUpdate, ctx) {
        signal?.throwIfAborted();
        const current = getManager(ctx);
        const snapshot = current.resume(params.agent_id, {
          prompt: params.prompt,
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
        "List user-defined agent Markdown configurations. Project .pi/agents definitions replace same-name global agents. No built-in types. Disabled definitions are listed but cannot be spawned.",
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
          structuredContent: result,
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
        "Read the managed task status/result and live sessionState. wait waits for the managed task, not independent native/user work.",
      parameters: Type.Object({
        agent_id: agentId,
        wait: Type.Optional(Type.Boolean()),
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
        "Send guidance to a running subagent after its current tools.",
      parameters: Type.Object({
        agent_id: agentId,
        message: Type.String({
          minLength: 1,
          maxLength: 100_000,
          pattern: "\\S",
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
        "Cancel a queued or running managed task without closing its view. Does not cancel independent native/user work.",
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

  pi.on("session_shutdown", async () => {
    const current = manager;
    manager = undefined;
    status?.dispose();
    status = undefined;
    context = undefined;
    await current?.close();
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
