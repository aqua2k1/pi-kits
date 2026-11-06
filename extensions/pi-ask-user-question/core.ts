import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";

const text = (description: string) =>
  Type.String({ minLength: 1, pattern: "\\S", description });

export const AskUserParameters = Type.Object({
  questions: Type.Array(
    Type.Object({
      question: text("The question to ask the user."),
      multiSelect: Type.Optional(
        Type.Boolean({
          default: false,
          description:
            "Allow multiple options to be selected. Defaults to single-choice; multi-select requires at least one option.",
        }),
      ),
      options: Type.Array(
        Type.Object({
          label: text("Short name for this choice."),
          description: Type.Optional(
            Type.String({
              description: "Explain the choice or its trade-offs.",
            }),
          ),
        }),
        {
          minItems: 1,
          description: "One or more choices. No upper limit on option count.",
        },
      ),
    }),
    {
      minItems: 1,
      description:
        "Related questions to ask together. No upper limit on question count.",
    },
  ),
});

const answerFields = {
  questionIndex: Type.Integer({
    minimum: 0,
    description: "Zero-based index of the question in the input array.",
  }),
  question: text("The original question text."),
  answer: text(
    "The selected label, custom text, or comma-separated selected labels.",
  ),
};

export const AskUserAnswerSchema = Type.Union([
  Type.Object(
    {
      ...answerFields,
      kind: Type.Literal("option", {
        description: "A single selected option.",
      }),
      optionIndex: Type.Integer({
        minimum: 0,
        description: "Zero-based index of the selected option.",
      }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...answerFields,
      kind: Type.Literal("custom", { description: "A user-written answer." }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...answerFields,
      kind: Type.Literal("multi", {
        description: "Multiple selected options.",
      }),
      selected: Type.Array(text("Selected option label."), {
        minItems: 1,
        description:
          "Selected labels in option order; duplicate labels are preserved.",
      }),
      optionIndices: Type.Array(Type.Integer({ minimum: 0 }), {
        minItems: 1,
        uniqueItems: true,
        description:
          "Zero-based selected option indices, sorted in ascending order.",
      }),
    },
    { additionalProperties: false },
  ),
]);

export const AskUserResultSchema = Type.Object(
  {
    answers: Type.Array(AskUserAnswerSchema, {
      description:
        "Confirmed answers in question order; cancellation may retain earlier answers.",
    }),
    cancelled: Type.Boolean({ description: "True when the user cancelled." }),
  },
  { additionalProperties: false },
);

export type AskUserParams = Static<typeof AskUserParameters>;
export type AskUserAnswer = {
  questionIndex: number;
  question: string;
  kind: "option" | "custom" | "multi";
  answer: string;
  optionIndex?: number;
  selected?: string[];
  optionIndices?: number[];
};
export type AskUserResult = {
  answers: AskUserAnswer[];
  cancelled: boolean;
};

export function buildMultiAnswer(
  question: AskUserParams["questions"][number],
  questionIndex: number,
  optionIndices: number[],
): AskUserAnswer {
  const indices = [...new Set(optionIndices)].sort((a, b) => a - b);
  if (
    !indices.length ||
    indices.some(
      (index) =>
        !Number.isInteger(index) ||
        index < 0 ||
        index >= question.options.length,
    )
  ) {
    throw new RangeError("Select at least one valid option index.");
  }
  const selected = indices.map((index) => question.options[index].label);
  return {
    questionIndex,
    question: question.question,
    kind: "multi",
    answer: selected.join(", "),
    selected,
    optionIndices: indices,
  };
}

export async function askQuestions(
  ui: Pick<ExtensionUIContext, "select" | "input">,
  params: AskUserParams,
  signal?: AbortSignal,
): Promise<AskUserResult> {
  const answers: AskUserAnswer[] = [];
  for (const [questionIndex, question] of params.questions.entries()) {
    signal?.throwIfAborted();
    const title = `[${questionIndex + 1}/${params.questions.length}] ${question.question}`;
    const rows = question.options.map(
      (option, index) =>
        `${index + 1}. ${option.label}${option.description ? ` — ${option.description}` : ""}`,
    );
    if (question.multiSelect) {
      const prompt = `${title}\n${rows.join("\n")}\nSelect one or more option numbers (comma/whitespace separated, e.g. 1,3), or type a custom answer. Use text: 123 for numeric custom text.`;
      while (true) {
        signal?.throwIfAborted();
        const input = await ui.input(prompt, "", { signal });
        signal?.throwIfAborted();
        if (input === undefined) return { answers, cancelled: true };
        const trimmed = input.trim();
        if (!trimmed) continue;

        const custom = /^text:\s*/i.test(trimmed)
          ? trimmed.replace(/^text:\s*/i, "")
          : undefined;
        if (custom !== undefined) {
          if (!custom.trim()) continue;
          answers.push({
            questionIndex,
            question: question.question,
            kind: "custom",
            answer: custom,
          });
          break;
        }

        // Numeric-looking input must be a valid list, never a custom fallback.
        if (/^[\d\s,+.-]+$/.test(trimmed)) {
          if (!/^\d+(?:(?:\s*,\s*|\s+)\d+)*$/.test(trimmed)) continue;
          const indices = trimmed
            .split(/[\s,]+/)
            .map((value) => Number(value) - 1);
          if (
            indices.some(
              (index) =>
                !Number.isInteger(index) ||
                index < 0 ||
                index >= question.options.length,
            )
          ) {
            continue;
          }
          answers.push(buildMultiAnswer(question, questionIndex, indices));
        } else {
          answers.push({
            questionIndex,
            question: question.question,
            kind: "custom",
            answer: input,
          });
        }
        break;
      }
      continue;
    }
    rows.push(`${rows.length + 1}. Type something.`);
    const chosen = await ui.select(title, rows, { signal });
    signal?.throwIfAborted();
    if (chosen === undefined) return { answers, cancelled: true };
    const optionIndex = rows.indexOf(chosen);
    if (optionIndex < 0) throw new Error("Host returned an unknown option.");

    if (optionIndex === question.options.length) {
      let answer: string | undefined;
      do {
        answer = await ui.input(`${title}\nType your answer (not blank):`, "", {
          signal,
        });
        signal?.throwIfAborted();
        if (answer === undefined) return { answers, cancelled: true };
      } while (!answer.trim());
      answers.push({
        questionIndex,
        question: question.question,
        kind: "custom",
        answer,
      });
    } else {
      answers.push({
        questionIndex,
        question: question.question,
        kind: "option",
        answer: question.options[optionIndex].label,
        optionIndex,
      });
    }
  }
  return { answers, cancelled: false };
}

export function buildResponse(result: AskUserResult) {
  const summary = JSON.stringify(result);
  return {
    content: [
      {
        type: "text" as const,
        text: result.cancelled
          ? "User cancelled"
          : `User answered the questionnaire: ${summary}`,
      },
    ],
    details: result,
    structuredContent: result,
  };
}
