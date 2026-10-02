import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import {
  AskUserParameters,
  AskUserResultSchema,
  askQuestions,
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

test("walks questions, exposes descriptions and preserves custom text", async () => {
  let count = 0;
  const ui = {
    async select(title: string, rows: string[]) {
      assert.match(title, /\[\d\/2\]/);
      assert.equal(rows[0], "1. A — Simple");
      return rows[count++ === 0 ? 1 : 2];
    },
    async input() {
      return "Custom answer\nwith detail";
    },
  };
  const result = await askQuestions(ui, { questions: [question, question] });
  assert.equal(result.cancelled, false);
  assert.deepEqual(
    result.answers.map((answer) => answer.kind),
    ["option", "custom"],
  );
  assert.equal(result.answers[0].optionIndex, 1);
  assert.equal(result.answers[1].answer, "Custom answer\nwith detail");
  const response = buildResponse(result);
  assert.deepEqual(response.details, result);
  assert.deepEqual(response.structuredContent, result);
  assert.ok(Value.Check(AskUserResultSchema, response.structuredContent));
});

test("cancelling returns only the cancellation message and retains answers in details", async () => {
  let count = 0;
  const result = await askQuestions(
    {
      async select(_title, rows) {
        return count++ === 0 ? rows[0] : undefined;
      },
      async input() {
        throw new Error("Unexpected input");
      },
    },
    { questions: [question, question] },
  );
  assert.equal(result.cancelled, true);
  assert.equal(result.answers.length, 1);
  const response = buildResponse(result);
  assert.equal(response.content[0].text, "User cancelled");
  assert.deepEqual(response.details, result);
});

test("blank custom input is retried and dismissal cancels", async () => {
  const replies = [" ", "", undefined];
  const result = await askQuestions(
    {
      async select(_title, rows) {
        return rows.at(-1);
      },
      async input() {
        return replies.shift();
      },
    },
    { questions: [question] },
  );
  assert.deepEqual(result, { answers: [], cancelled: true });
  assert.equal(buildResponse(result).content[0].text, "User cancelled");
  assert.equal(replies.length, 0);
});

test("duplicate labels and sentinel labels remain distinguishable by index", async () => {
  const result = await askQuestions(
    {
      async select(_title, rows) {
        return rows[1];
      },
      async input() {
        throw new Error("Unexpected input");
      },
    },
    {
      questions: [
        {
          question: "Choose?",
          options: [{ label: "Type something." }, { label: "Type something." }],
        },
      ],
    },
  );
  assert.equal(result.answers[0].kind, "option");
  assert.equal(result.answers[0].optionIndex, 1);
});

test("rejects invalid host responses", async () => {
  await assert.rejects(
    askQuestions(
      {
        async select() {
          return "invalid";
        },
        async input() {
          return "unused";
        },
      },
      { questions: [question] },
    ),
    /unknown option/,
  );
});

test("abort signal reaches dialogs and stops the questionnaire", async () => {
  const controller = new AbortController();
  const ui: Pick<ExtensionUIContext, "select" | "input"> = {
    async select(_title, rows, opts) {
      assert.equal(opts?.signal, controller.signal);
      controller.abort();
      return rows[0];
    },
    async input() {
      throw new Error("Unexpected input");
    },
  };
  await assert.rejects(
    askQuestions(ui, { questions: [question] }, controller.signal),
    { name: "AbortError" },
  );
  await assert.rejects(
    askQuestions(ui, { questions: [question] }, controller.signal),
    { name: "AbortError" },
  );
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

test("RPC multi-select uses numbered input and preserves duplicate labels", async () => {
  const controller = new AbortController();
  const result = await askQuestions(
    {
      async select() {
        throw new Error("Multi-select must use input, not select");
      },
      async input(title, _placeholder, opts) {
        assert.equal(opts?.signal, controller.signal);
        assert.match(title, /\[1\/1\] Which approach\?/);
        assert.match(title, /1\. A — Simple\n2\. B\n3\. A/);
        assert.match(title, /comma\/whitespace/);
        assert.match(title, /text: 123/);
        return "3, 1 3,2";
      },
    },
    {
      questions: [
        {
          ...question,
          multiSelect: true,
          options: [...question.options, { label: "A" }],
        },
      ],
    },
    controller.signal,
  );
  assert.deepEqual(result, {
    answers: [
      {
        questionIndex: 0,
        question: question.question,
        kind: "multi",
        answer: "A, B, A",
        selected: ["A", "B", "A"],
        optionIndices: [0, 1, 2],
      },
    ],
    cancelled: false,
  });
});

test("RPC multi-select retries blank and invalid numeric lists in full", async () => {
  const replies = [
    "",
    " \n ",
    "0",
    "3",
    "1,3",
    "-1",
    "1.5",
    "1,,2",
    "1,",
    "text: ",
    "2 1",
  ];
  const result = await askQuestions(
    {
      async select() {
        throw new Error("Unexpected select");
      },
      async input() {
        return replies.shift();
      },
    },
    { questions: [{ ...question, multiSelect: true }] },
  );
  assert.equal(replies.length, 0);
  assert.equal(result.cancelled, false);
  assert.deepEqual(result.answers[0].optionIndices, [0, 1]);
  assert.equal(result.answers[0].answer, "A, B");
});

test("RPC multi-select accepts custom text and explicitly prefixed digits", async () => {
  for (const [input, answer] of [
    [" Other answer\nwith detail ", " Other answer\nwith detail "],
    ["1, other", "1, other"],
    ["text: 123", "123"],
    ["TEXT: 0", "0"],
  ]) {
    const result = await askQuestions(
      {
        async select() {
          throw new Error("Unexpected select");
        },
        async input() {
          return input;
        },
      },
      { questions: [{ ...question, multiSelect: true }] },
    );
    assert.deepEqual(result, {
      answers: [
        {
          questionIndex: 0,
          question: question.question,
          kind: "custom",
          answer,
        },
      ],
      cancelled: false,
    });
  }
});

test("RPC multi-select cancellation preserves earlier answers", async () => {
  const replies = ["2", " ", "0", undefined];
  const result = await askQuestions(
    {
      async select() {
        throw new Error("Unexpected select");
      },
      async input() {
        return replies.shift();
      },
    },
    { questions: Array(2).fill({ ...question, multiSelect: true }) },
  );
  assert.equal(replies.length, 0);
  assert.deepEqual(result, {
    answers: [buildMultiAnswer(question, 0, [1])],
    cancelled: true,
  });
});

test("RPC multi-select checks abort before input and after every response", async () => {
  for (const response of ["1", " ", "custom", undefined]) {
    const controller = new AbortController();
    let calls = 0;
    const ui: Pick<ExtensionUIContext, "select" | "input"> = {
      async select() {
        throw new Error("Unexpected select");
      },
      async input(_title, _placeholder, opts) {
        assert.equal(opts?.signal, controller.signal);
        calls++;
        controller.abort();
        return response;
      },
    };
    const params = { questions: [{ ...question, multiSelect: true }] };
    await assert.rejects(askQuestions(ui, params, controller.signal), {
      name: "AbortError",
    });
    await assert.rejects(askQuestions(ui, params, controller.signal), {
      name: "AbortError",
    });
    assert.equal(calls, 1);
  }
});

test("explicit multiSelect false retains single-select behavior", async () => {
  const result = await askQuestions(
    {
      async select(_title, rows) {
        return rows[1];
      },
      async input() {
        throw new Error("Unexpected input");
      },
    },
    { questions: [{ ...question, multiSelect: false }] },
  );
  assert.deepEqual(result, {
    answers: [
      {
        questionIndex: 0,
        question: question.question,
        kind: "option",
        answer: "B",
        optionIndex: 1,
      },
    ],
    cancelled: false,
  });
});
