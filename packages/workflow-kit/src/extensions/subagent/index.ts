import { randomUUID } from "node:crypto";
import {
  defineTool,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { readPiKitsConfig } from "@pi-kits/config";
import { Type } from "typebox";
import {
  DOCKED_PANEL_CLOSED,
  DOCKED_PANEL_OPENED,
} from "../../lib/ui/docked-panel/index.ts";
import { HerdrAdapter } from "./herdr.ts";
import { type AgentSnapshot, SubagentManager } from "./manager.ts";
import type { MuxAdapter } from "./mux.ts";
import { SubagentStatusWidget } from "./status-widget.ts";
import { showSubagentViews } from "./views.ts";

const agentId = Type.String({ minLength: 1, description: "Subagent ID" });
const thinking = Type.Union([
  Type.Literal("off"),
  Type.Literal("minimal"),
  Type.Literal("low"),
  Type.Literal("medium"),
  Type.Literal("high"),
  Type.Literal("xhigh"),
  Type.Literal("max"),
]);

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
): void {
  let manager: SubagentManager | undefined;
  let status: SubagentStatusWidget | undefined;
  let context: ExtensionContext | undefined;
  const getManager = (ctx?: ExtensionContext) => {
    context = ctx ?? context;
    manager ??= new SubagentManager(adapter, {
      maxConcurrent,
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
      description:
        "Run a task in an independent Pi session hosted by Herdr. Background by default. Workers share the filesystem and are not a sandbox. Use /subagent:views to open the running Pi for native terminal control.",
      parameters: Type.Object({
        prompt: Type.String({
          minLength: 1,
          maxLength: 100_000,
          pattern: "\\S",
        }),
        description: Type.String({ minLength: 1, maxLength: 200 }),
        model: Type.Optional(Type.String({ minLength: 1 })),
        thinking: Type.Optional(thinking),
        run_in_background: Type.Optional(Type.Boolean({ default: true })),
      }),
      async execute(_id, params, signal, _onUpdate, ctx) {
        signal?.throwIfAborted();
        const current = getManager(ctx);
        const snapshot = current.spawn({
          prompt: params.prompt,
          description: params.description,
          cwd: ctx.cwd,
          model:
            params.model ??
            (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined),
          thinking: params.thinking ?? pi.getThinkingLevel(),
        });
        if (params.run_in_background !== false) return toolResult(snapshot);
        return toolResult(await current.result(snapshot.id, true, signal));
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "get_subagent_result",
      label: "Subagent result",
      description: "Read a subagent's status and result, optionally waiting.",
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
        current.steer(params.agent_id, params.message);
        return toolResult(current.get(params.agent_id));
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "stop_subagent",
      label: "Stop subagent",
      description: "Cancel a queued or running task without closing its view.",
      parameters: Type.Object({ agent_id: agentId }),
      async execute(_id, params) {
        return toolResult(getManager().stop(params.agent_id));
      },
    }),
  );

  pi.registerCommand("subagent:views", {
    description: "View/control a subagent: [id] [right|down|close|focus]",
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
            "Usage: /subagent:views [id] [right|down|close|focus]",
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
        if (action === "close") await current.closeView(id);
        else if (
          action === "right" ||
          action === "down" ||
          action === "focus"
        ) {
          await current.openView(id, action === "down" ? "down" : "right");
        } else {
          throw new Error("View action must be right, down, close, or focus.");
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
  const { workflow } = readPiKitsConfig();
  if (
    !workflow.enabled ||
    !workflow.subagent.enabled ||
    workflow.subagent.mux !== "herdr"
  ) {
    return;
  }
  const adapter = new HerdrAdapter();
  if (!adapter.check_env()) return;
  registerSubagents(pi, adapter, workflow.subagent.maxConcurrent);
}
