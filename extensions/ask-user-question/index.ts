import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readPiKitsConfig } from "@pi-kits/config";
import {
  bindUIHost,
  classifyUIFailure,
  type UIFailureStatus,
  type UIHost,
} from "@pi-kits/shared/ui/host";
import { notify } from "../../shared/notifications/index.ts";
import {
  DOCKED_PANEL_CLOSED,
  DOCKED_PANEL_OPENED,
  type DockedPanelClosedEvent,
  type DockedPanelOpenedEvent,
} from "../../shared/ui/docked-panel/events.ts";
import {
  compactCall,
  compactResult,
  record,
} from "../../shared/ui/renderers.ts";
import {
  AskUserParameters,
  type AskUserResult,
  AskUserResultSchema,
  buildResponse,
} from "./core.ts";
import {
  ASK_USER_QUESTION_END,
  ASK_USER_QUESTION_START,
  type AskUserQuestionEndEvent,
  type AskUserQuestionStartEvent,
} from "./events.ts";
import { askQuestions } from "./interaction.ts";

export default function askUserQuestionExtension(pi: ExtensionAPI): void {
  const { askUserQuestion, notify: notifyConfig } = readPiKitsConfig();
  if (!askUserQuestion.enabled) return;

  pi.registerTool({
    name: "ask_user_question",
    label: "Ask User Question",
    renderCall: compactCall("Ask User Question", (args) => {
      const questions = record(args).questions;
      if (!Array.isArray(questions)) return "";
      return `${questions.length} questions · ${record(questions[0]).question ?? ""}`;
    }),
    renderResult: compactResult((details) => {
      const data = record(details);
      if (!Array.isArray(data.answers) || typeof data.cancelled !== "boolean")
        return;
      return {
        status: data.cancelled
          ? "cancelled"
          : `answered · ${data.answers.length} answers`,
        preview: data.answers
          .map((answer) => record(answer).answer ?? "")
          .join(" · "),
      };
    }),
    description:
      "Ask the user structured questions to clarify requirements or choose an approach. Supports single-choice, multi-select, and custom answers.",
    promptSnippet: "Ask the user to clarify requirements or choose an approach",
    promptGuidelines: [
      "Batch related clarification questions into one call. Keep the questionnaire concise.",
      "Put a recommended option first and append (Recommended) to its label.",
      "Do not add a custom-answer option; users can provide custom answers to every question.",
      "Set multiSelect: true when multiple answers are valid.",
    ],
    exposure: "model-only",
    executionMode: "sequential",
    parameters: AskUserParameters,
    outputSchema: AskUserResultSchema,
    async execute(id, params, signal, _onUpdate, ctx) {
      if (!ctx.hasUI)
        throw new Error("UI unavailable; ask in plain chat instead.");
      signal?.throwIfAborted();
      const askTui =
        ctx.mode === "tui"
          ? (await import("./tui.ts")).askTabbedQuestions
          : undefined;
      signal?.throwIfAborted();
      if (!askTui) ctx.signal?.throwIfAborted();
      const start: AskUserQuestionStartEvent = {
        toolCallId: id,
        mode: ctx.mode,
        questionCount: params.questions.length,
      };
      let end: AskUserQuestionEndEvent = { ...start, status: "error" };
      pi.events.emit(ASK_USER_QUESTION_START, start);
      let host: UIHost | undefined;
      let failureStatus: UIFailureStatus | undefined;
      try {
        if (ctx.mode === "tui" && notifyConfig.enabled) {
          notify("Pi", "Waiting for your answer.");
        }
        const panel: DockedPanelOpenedEvent = {
          panelId: "ask-user-question",
          instanceId: id,
        };
        let result: AskUserResult;
        if (askTui) {
          result = await askTui(ctx.ui, params, signal, {
            onOpen: () => pi.events.emit(DOCKED_PANEL_OPENED, panel),
            onClosed: (status) => {
              if (status === "aborted" || status === "error")
                failureStatus = status;
              const closed: DockedPanelClosedEvent = { ...panel, status };
              pi.events.emit(DOCKED_PANEL_CLOSED, closed);
            },
          });
        } else {
          host = bindUIHost(ctx);
          result = await askQuestions(host, params, signal, id, {
            onClosed(outcome) {
              if (outcome.status === "aborted" || outcome.status === "error") {
                failureStatus = outcome.status;
              }
            },
          });
        }
        end = {
          ...start,
          status: result.cancelled ? "cancelled" : "answered",
          result,
        };
        return buildResponse(result);
      } catch (error) {
        end = {
          ...start,
          status:
            failureStatus ?? (askTui ? classifyUIFailure(signal) : "error"),
        };
        throw error;
      } finally {
        if (host) await host.dispose();
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
