import {
  assertUIEventForView,
  type UIEvent,
  type UIField,
  type UINode,
  type UIView,
} from "@pi-kits/shared/ui/protocol";
import { Value } from "typebox/value";
import {
  type AskUserAnswer,
  AskUserParameters,
  type AskUserParams,
  type AskUserResult,
  buildMultiAnswer,
} from "./core.ts";

export interface QuestionnaireTransition {
  view?: UIView;
  result?: AskUserResult;
}

export interface QuestionnaireController {
  getView(): UIView;
  handle(event: UIEvent): QuestionnaireTransition;
}

/** Business-owned sequential workflow; no Pi context, rendering or session APIs. */
export function createQuestionnaireController(
  params: AskUserParams,
  viewId = "ask-user-question",
): QuestionnaireController {
  if (!Value.Check(AskUserParameters, params)) {
    throw new TypeError("Invalid questionnaire parameters.");
  }
  const questions = structuredClone(params.questions);
  const answers: AskUserAnswer[] = [];
  let active = 0;
  let revision = 0;
  let single: number | null = null;
  let multiple: number[] = [];
  let draft = "";
  let custom = false;
  let touched = false;
  let completed = false;

  const valid = () =>
    custom
      ? draft.trim().length > 0
      : questions[active].multiSelect
        ? multiple.length > 0
        : single !== null;

  const getView = (): UIView => {
    const question = questions[active];
    const error = custom
      ? "Type a non-blank answer."
      : "Select at least one option.";
    const feedback = touched && !valid() ? { error } : {};
    let field: UIField;
    if (custom) {
      field = {
        kind: "field",
        id: "custom",
        label: "Custom answer",
        type: "text",
        value: draft,
        ...feedback,
      };
    } else {
      const options = question.options.map((option, index) => ({
        id: `option:${index}`,
        label: option.label,
        ...(option.description === undefined
          ? {}
          : { description: option.description }),
      }));
      field = question.multiSelect
        ? {
            kind: "field",
            id: "choice",
            label: "Selected options",
            type: "multiple",
            value: multiple.map((index) => `option:${index}`),
            options,
            ...feedback,
          }
        : {
            kind: "field",
            id: "choice",
            label: "Selected option",
            type: "single",
            value: single === null ? null : `option:${single}`,
            options,
            ...feedback,
          };
    }
    const children: UINode[] = [
      field,
      {
        kind: "action",
        id: "confirm",
        label: "Confirm answer",
        emphasis: "primary",
        disabled: !valid(),
      },
      {
        kind: "action",
        id: custom ? "use-options" : "use-custom",
        label: custom ? "Choose options" : "Write custom answer",
      },
    ];
    return {
      id: viewId,
      revision,
      root: {
        kind: "group",
        id: "question",
        title: `[${active + 1}/${questions.length}] ${question.question}`,
        children,
      },
    };
  };

  const controller: QuestionnaireController = {
    getView,
    handle(event) {
      if (completed) throw new Error("Questionnaire already completed.");
      assertUIEventForView(getView(), event);
      if (event.type === "dismiss") {
        completed = true;
        return {
          result: { answers: structuredClone(answers), cancelled: true },
        };
      }
      const question = questions[active];
      if (event.type === "change") {
        if (custom) {
          if (typeof event.value !== "string") {
            throw new Error("Invalid custom answer value.");
          }
          draft = event.value;
        } else if (question.multiSelect) {
          if (!Array.isArray(event.value)) {
            throw new Error("Invalid multi-select value.");
          }
          multiple = event.value.map((id) =>
            question.options.findIndex(
              (_option, index) => id === `option:${index}`,
            ),
          );
        } else {
          if (event.value !== null && typeof event.value !== "string") {
            throw new Error("Invalid single-select value.");
          }
          single =
            event.value === null
              ? null
              : question.options.findIndex(
                  (_option, index) => event.value === `option:${index}`,
                );
        }
        touched = true;
      } else if (
        event.nodeId === "use-custom" ||
        event.nodeId === "use-options"
      ) {
        custom = event.nodeId === "use-custom";
        touched = false;
      } else if (event.nodeId === "confirm") {
        if (!valid()) throw new Error("Answer is not ready.");
        let answer: AskUserAnswer;
        if (custom) {
          answer = {
            questionIndex: active,
            question: question.question,
            kind: "custom",
            answer: draft,
          };
        } else if (question.multiSelect) {
          answer = buildMultiAnswer(question, active, multiple);
        } else {
          if (single === null) throw new Error("Answer is not ready.");
          answer = {
            questionIndex: active,
            question: question.question,
            kind: "option",
            answer: question.options[single].label,
            optionIndex: single,
          };
        }
        answers.push(answer);
        if (active === questions.length - 1) {
          completed = true;
          return {
            result: { answers: structuredClone(answers), cancelled: false },
          };
        }
        active++;
        single = null;
        multiple = [];
        draft = "";
        custom = false;
        touched = false;
      } else {
        throw new Error("Unknown questionnaire action.");
      }
      revision++;
      return { view: getView() };
    },
  };
  return controller;
}
