import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readPiKitsConfig } from "@pi-kits/config";
import { notify } from "../../lib/notifications/index.ts";
import {
  DOCKED_PANEL_CLOSED,
  DOCKED_PANEL_OPENED,
  type DockedPanelClosedEvent,
  type DockedPanelOpenedEvent,
} from "../../lib/ui/docked-panel/events.ts";
import {
  AskUserParameters,
  type AskUserResult,
  AskUserResultSchema,
  askQuestions,
  buildResponse,
} from "./core.ts";
import {
  ASK_USER_QUESTION_END,
  ASK_USER_QUESTION_START,
  type AskUserQuestionEndEvent,
  type AskUserQuestionStartEvent,
} from "./events.ts";

export default function askUserQuestionExtension(pi: ExtensionAPI): void {
  const { workflow } = readPiKitsConfig();
  if (!workflow.enabled || !workflow.askUserQuestion.enabled) return;

  pi.registerTool({
    name: "ask_user_question",
    label: "Ask User Question",
    description:
      "Ask the user structured questions to clarify requirements or choose an approach. Supports single-choice, multi-select, and custom answers.",
    promptSnippet: "Ask the user to clarify requirements or choose an approach",
    promptGuidelines: [
      "Batch related clarification questions into one call. Keep the questionnaire concise.",
      "Put a recommended option first and append (Recommended) to its label.",
      "Do not add a custom-answer option; users can provide custom answers to every question.",
      "Set multiSelect: true when multiple answers are valid; selecting at least one option is required.",
    ],
    exposure: "model-only",
    executionMode: "sequential",
    parameters: AskUserParameters,
    outputSchema: AskUserResultSchema,
    async execute(id, params, signal, _onUpdate, ctx) {
      if (!ctx.hasUI)
        throw new Error("UI unavailable; ask in plain chat instead.");
      signal?.throwIfAborted();
      const ask =
        ctx.mode === "tui"
          ? (await import("./tui.ts")).askTabbedQuestions
          : askQuestions;
      signal?.throwIfAborted();
      const start: AskUserQuestionStartEvent = {
        toolCallId: id,
        mode: ctx.mode,
        questionCount: params.questions.length,
      };
      let end: AskUserQuestionEndEvent = { ...start, status: "error" };
      pi.events.emit(ASK_USER_QUESTION_START, start);
      try {
        if (ctx.mode === "tui" && workflow.notify.enabled) {
          notify("Pi", "Waiting for your answer.");
        }
        const panel: DockedPanelOpenedEvent = {
          panelId: "ask-user-question",
          instanceId: id,
        };
        const result: AskUserResult = await ask(
          ctx.ui,
          params,
          signal,
          ctx.mode === "tui"
            ? {
                onOpen: () => pi.events.emit(DOCKED_PANEL_OPENED, panel),
                onClosed: (status) => {
                  const closed: DockedPanelClosedEvent = { ...panel, status };
                  pi.events.emit(DOCKED_PANEL_CLOSED, closed);
                },
              }
            : undefined,
        );
        end = {
          ...start,
          status: result.cancelled ? "cancelled" : "answered",
          result,
        };
        return buildResponse(result);
      } catch (error) {
        end = {
          ...start,
          status: signal?.aborted ? "aborted" : "error",
        };
        throw error;
      } finally {
        pi.events.emit(ASK_USER_QUESTION_END, end);
      }
    },
  });

  pi.on("before_agent_start", (_event, ctx) => {
    const active = pi.getActiveTools();
    const name = "ask_user_question";
    if (!ctx.hasUI && active.includes(name)) {
      pi.setActiveTools(active.filter((tool) => tool !== name));
    } else if (ctx.hasUI && !active.includes(name)) {
      pi.setActiveTools([...active, name]);
    }
  });
}
