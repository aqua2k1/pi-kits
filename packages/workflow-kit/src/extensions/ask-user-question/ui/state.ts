import {
  type AskUserAnswer,
  type AskUserParams,
  type AskUserResult,
  buildMultiAnswer,
} from "../core.ts";

export interface QuestionnaireState {
  active: number;
  selected: number[];
  checked: number[][];
  drafts: string[];
  answers: (AskUserAnswer | undefined)[];
  reviewIndex: number;
  buttonIndex: number;
}

export type QuestionnaireAction =
  | { type: "tab"; index: number }
  | { type: "switch"; delta: number }
  | { type: "move"; delta: number }
  | { type: "select"; index: number }
  | { type: "toggle" }
  | { type: "review"; delta: number }
  | { type: "draft"; value: string }
  | { type: "confirm" }
  | { type: "cancel" };

export function createQuestionnaireState(
  params: AskUserParams,
): QuestionnaireState {
  return {
    active: 0,
    selected: params.questions.map(() => 0),
    checked: params.questions.map(() => []),
    drafts: params.questions.map(() => ""),
    answers: params.questions.map(() => undefined),
    reviewIndex: 0,
    buttonIndex: 0,
  };
}

const wrap = (index: number, count: number) =>
  ((index % count) + count) % count;

export function questionnaireResult(
  state: QuestionnaireState,
  cancelled: boolean,
): AskUserResult {
  return {
    answers: state.answers.filter(
      (answer): answer is AskUserAnswer => answer !== undefined,
    ),
    cancelled,
  };
}

/** Drafts and highlighted options are not answers until explicitly confirmed. */
export function reduceQuestionnaire(
  state: QuestionnaireState,
  params: AskUserParams,
  action: QuestionnaireAction,
): { state: QuestionnaireState; result?: AskUserResult } {
  const count = params.questions.length;
  const question = params.questions[state.active];
  if (action.type === "cancel") {
    return { state, result: questionnaireResult(state, true) };
  }
  if (action.type === "tab") {
    return {
      state:
        Number.isInteger(action.index) &&
        action.index >= 0 &&
        action.index <= count
          ? { ...state, active: action.index }
          : state,
    };
  }
  if (action.type === "switch") {
    return {
      state: { ...state, active: wrap(state.active + action.delta, count + 1) },
    };
  }
  if (action.type === "review") {
    return {
      state: {
        ...state,
        reviewIndex: wrap(state.reviewIndex + action.delta, count),
      },
    };
  }
  if (action.type === "move" || action.type === "select") {
    if (!question) {
      const index =
        action.type === "select"
          ? action.index
          : wrap(state.buttonIndex + action.delta, 2);
      return {
        state:
          index === 0 || index === 1 ? { ...state, buttonIndex: index } : state,
      };
    }
    const index =
      action.type === "select"
        ? action.index
        : wrap(
            (question ? state.selected[state.active] : state.reviewIndex) +
              action.delta,
            question ? question.options.length + 1 : count,
          );
    if (index < 0 || index > question.options.length) return { state };
    const selected = [...state.selected];
    selected[state.active] = index;
    return { state: { ...state, selected } };
  }
  if (action.type === "toggle") {
    if (!question?.multiSelect) return { state };
    const index = state.selected[state.active];
    if (index >= question.options.length) return { state };
    const checked = [...state.checked];
    const current = checked[state.active];
    checked[state.active] = current.includes(index)
      ? current.filter((value) => value !== index)
      : [...current, index].sort((a, b) => a - b);
    return { state: { ...state, checked } };
  }
  if (action.type === "draft") {
    if (!question) return { state };
    const drafts = [...state.drafts];
    drafts[state.active] = action.value;
    return { state: { ...state, drafts } };
  }
  if (!question) {
    if (state.buttonIndex === 1) {
      return { state, result: questionnaireResult(state, true) };
    }
    return {
      state,
      result: state.answers.every((answer) => answer !== undefined)
        ? questionnaireResult(state, false)
        : undefined,
    };
  }
  const optionIndex = state.selected[state.active];
  const custom = optionIndex === question.options.length;
  const answer = custom
    ? state.drafts[state.active]
    : question.options[optionIndex].label;
  if (custom && !answer.trim()) return { state };
  if (
    question.multiSelect &&
    !custom &&
    state.checked[state.active].length === 0
  ) {
    return { state };
  }
  const answers = [...state.answers];
  answers[state.active] =
    question.multiSelect && !custom
      ? buildMultiAnswer(question, state.active, state.checked[state.active])
      : {
          questionIndex: state.active,
          question: question.question,
          kind: custom ? "custom" : "option",
          answer,
          ...(custom ? {} : { optionIndex }),
        };
  // Last question advances to review, never submits implicitly.
  return { state: { ...state, answers, active: state.active + 1 } };
}
