import assert from "node:assert/strict";
import { test } from "node:test";
import { Value } from "typebox/value";
import {
  AskUserParameters,
  AskUserResultSchema,
  buildMultiAnswer,
  buildResponse,
} from "./core.ts";

const question = {
  question: "Which approach?",
  options: [{ label: "A", description: "Simple" }, { label: "B" }],
};

test("schema has no upper count or text length limits", () => {
  const options = Array.from({ length: 100 }, (_, i) => ({
    label: `${i}${"x".repeat(100)}`,
  }));
  assert.ok(
    Value.Check(AskUserParameters, {
      questions: Array.from({ length: 20 }, () => ({
        question: "Choose?",
        options,
      })),
    }),
  );
  for (const params of [
    { questions: [] },
    { questions: [{ ...question, options: [] }] },
    { questions: [{ ...question, question: " " }] },
    { questions: [{ ...question, options: [{ label: " " }] }] },
  ]) {
    assert.equal(Value.Check(AskUserParameters, params), false);
  }
});

test("output schema validates every answer kind and the cancellation envelope", () => {
  const variants = [
    {
      questionIndex: 0,
      question: question.question,
      kind: "option",
      answer: "A",
      optionIndex: 0,
    },
    {
      questionIndex: 0,
      question: question.question,
      kind: "custom",
      answer: "My answer",
    },
    buildMultiAnswer(question, 0, [0, 1]),
  ];
  for (const answer of variants) {
    for (const cancelled of [false, true]) {
      const result = { answers: [answer], cancelled };
      assert.ok(Value.Check(AskUserResultSchema, result));
    }
  }
  const cancelled = buildResponse({ answers: [], cancelled: true });
  assert.ok(Value.Check(AskUserResultSchema, cancelled.structuredContent));
  assert.equal(cancelled.content[0].text, "User cancelled");
  assert.deepEqual(cancelled.structuredContent, cancelled.details);
  for (const answer of [
    { ...variants[0], optionIndex: -1 },
    { ...variants[0], kind: "unknown" },
    { ...variants[1], selected: ["A"] },
    { ...variants[2], optionIndices: [] },
    { ...variants[2], optionIndices: [0, 0] },
    { ...variants[2], selected: [] },
  ]) {
    assert.equal(
      Value.Check(AskUserResultSchema, { answers: [answer], cancelled: false }),
      false,
    );
  }
});

test("multiSelect is an optional boolean defaulting to false", () => {
  for (const multiSelect of [undefined, false, true]) {
    assert.ok(
      Value.Check(AskUserParameters, {
        questions: [{ ...question, multiSelect }],
      }),
    );
  }
  for (const multiSelect of [null, 0, 1, "true", "false", [], {}]) {
    assert.equal(
      Value.Check(AskUserParameters, {
        questions: [{ ...question, multiSelect }],
      }),
      false,
    );
  }
  assert.equal(
    Reflect.get(
      AskUserParameters.properties.questions.items.properties.multiSelect,
      "default",
    ),
    false,
  );
});

test("buildMultiAnswer sorts and deduplicates indices, not labels", () => {
  const indices = [2, 0, 2, 1];
  const result = buildMultiAnswer(
    {
      ...question,
      options: [{ label: "A" }, { label: "B" }, { label: "A" }],
    },
    4,
    indices,
  );
  assert.deepEqual(result, {
    questionIndex: 4,
    question: question.question,
    kind: "multi",
    answer: "A, B, A",
    selected: ["A", "B", "A"],
    optionIndices: [0, 1, 2],
  });
  assert.deepEqual(indices, [2, 0, 2, 1]);
  for (const invalid of [[], [-1], [2], [0.5], [Number.NaN]]) {
    assert.throws(() => buildMultiAnswer(question, 0, invalid), RangeError);
  }
});
