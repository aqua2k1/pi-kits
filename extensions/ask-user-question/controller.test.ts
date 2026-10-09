import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  assertUIView,
  type UIEvent,
  type UIField,
  type UINode,
} from "@pi-kits/shared/ui/protocol";
import { Value } from "typebox/value";
import { createQuestionnaireController } from "./controller.ts";
import { AskUserResultSchema, buildMultiAnswer } from "./core.ts";

const question = {
  question: "Which approach?",
  options: [{ label: "A", description: "Simple" }, { label: "B" }],
};
type Controller = ReturnType<typeof createQuestionnaireController>;
type Payload =
  | { type: "change"; nodeId: string; value: string | null | string[] }
  | { type: "invoke"; nodeId: string }
  | { type: "dismiss" };
function send(controller: Controller, payload: Payload) {
  const before = controller.getView();
  const event: UIEvent = {
    viewId: before.id,
    revision: before.revision,
    ...payload,
  };
  const update = controller.handle(event);
  if (update.view) {
    assert.equal(update.view.revision, before.revision + 1);
    assert.equal(update.view.id, before.id);
    assertUIView(JSON.parse(JSON.stringify(update.view)));
    assert.deepEqual(controller.getView(), update.view);
  }
  if (update.result) assert.ok(Value.Check(AskUserResultSchema, update.result));
  return update;
}
function invoke(controller: Controller, nodeId: string) {
  return send(controller, { type: "invoke", nodeId });
}
function change(
  controller: Controller,
  nodeId: string,
  value: UIField["value"],
) {
  return send(controller, { type: "change", nodeId, value });
}
function node(controller: Controller, id: string): UINode {
  const root = controller.getView().root;
  assert.equal(root.kind, "group");
  assert.ok(root.kind === "group");
  const found = root.children.find((child) => child.id === id);
  assert.ok(found);
  return found;
}
function field(controller: Controller, id: string): UIField {
  const found = node(controller, id);
  assert.ok(found.kind === "field");
  return found;
}
function confirmEnabled(controller: Controller, enabled: boolean) {
  const confirm = node(controller, "confirm");
  assert.ok(confirm.kind === "action");
  assert.equal(Boolean(confirm.disabled), !enabled);
}
const config = { timeout: 2000 };

test("initial view roundtrips with stable IDs", config, () => {
  for (const multiSelect of [false, true]) {
    const controller = createQuestionnaireController({
      questions: [{ ...question, multiSelect }],
    });
    const view = controller.getView();
    assertUIView(JSON.parse(JSON.stringify(view)));
    assert.equal(view.id, "ask-user-question");
    assert.equal(view.root.id, "question");
    assert.ok(view.root.kind === "group");
    assert.equal(view.root.title, "[1/1] Which approach?");
    const choice = field(controller, "choice");
    assert.equal(choice.type, multiSelect ? "multiple" : "single");
    assert.deepEqual(choice.value, multiSelect ? [] : null);
    assert.ok("options" in choice);
    assert.deepEqual(choice.options, [
      { id: "option:0", label: "A", description: "Simple" },
      { id: "option:1", label: "B" },
    ]);
    confirmEnabled(controller, false);
    assert.ok(node(controller, "use-custom"));
  }
});

test("drafts, sequential confirm and completion", config, () => {
  const controller = createQuestionnaireController(
    { questions: [question, { ...question, multiSelect: false }] },
    "instance",
  );
  const draft = change(controller, "choice", "option:1");
  assert.equal(draft.result, undefined);
  confirmEnabled(controller, true);
  const first = invoke(controller, "confirm");
  assert.equal(first.result, undefined);
  assert.ok(first.view?.root.kind === "group");
  assert.equal(first.view.root.title, "[2/2] Which approach?");
  assert.equal(field(controller, "choice").value, null);
  confirmEnabled(controller, false);
  change(controller, "choice", "option:0");
  const lastView = controller.getView();
  const final = invoke(controller, "confirm");
  assert.deepEqual(final.result, {
    cancelled: false,
    answers: [
      {
        questionIndex: 0,
        question: question.question,
        kind: "option",
        answer: "B",
        optionIndex: 1,
      },
      {
        questionIndex: 1,
        question: question.question,
        kind: "option",
        answer: "A",
        optionIndex: 0,
      },
    ],
  });
  assert.deepEqual(controller.getView(), lastView);
  assert.throws(
    () => invoke(controller, "confirm"),
    /Questionnaire already completed\./,
  );
});

test("multi sorting and duplicate label IDs", config, () => {
  const duplicate = {
    ...question,
    multiSelect: true,
    options: [
      { label: "Type something." },
      { label: "Type something." },
      { label: "B" },
    ],
  };
  const controller = createQuestionnaireController({ questions: [duplicate] });
  const choice = field(controller, "choice");
  assert.ok(choice.type === "multiple");
  assert.deepEqual(
    choice.options.map((option) => option.id),
    ["option:0", "option:1", "option:2"],
  );
  change(controller, "choice", ["option:2", "option:1", "option:0"]);
  assert.deepEqual(invoke(controller, "confirm").result, {
    answers: [buildMultiAnswer(duplicate, 0, [2, 1, 0])],
    cancelled: false,
  });
  const single = createQuestionnaireController({
    questions: [{ ...duplicate, multiSelect: false }],
  });
  change(single, "choice", "option:1");
  assert.equal(invoke(single, "confirm").result?.answers[0].optionIndex, 1);
});

test("custom text stays literal", config, () => {
  for (const answer of [
    " Other answer\nwith detail ",
    "1,2",
    "text: 123",
    "TEXT: 0",
  ]) {
    const controller = createQuestionnaireController({
      questions: [{ ...question, multiSelect: true }],
    });
    invoke(controller, "use-custom");
    assert.equal(field(controller, "custom").type, "text");
    assert.equal(field(controller, "custom").value, "");
    confirmEnabled(controller, false);
    for (const blank of ["", " \n\t "]) {
      change(controller, "custom", blank);
      confirmEnabled(controller, false);
      assert.throws(() => invoke(controller, "confirm"));
    }
    change(controller, "custom", answer);
    confirmEnabled(controller, true);
    assert.deepEqual(invoke(controller, "confirm").result, {
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

test("mode switches preserve drafts", config, () => {
  for (const multiSelect of [false, true]) {
    const controller = createQuestionnaireController({
      questions: [{ ...question, multiSelect }],
    });
    const choice = multiSelect ? ["option:1"] : "option:1";
    change(controller, "choice", choice);
    invoke(controller, "use-custom");
    change(controller, "custom", " draft ");
    invoke(controller, "use-options");
    assert.deepEqual(field(controller, "choice").value, choice);
    confirmEnabled(controller, true);
    change(controller, "choice", multiSelect ? [] : null);
    confirmEnabled(controller, false);
    invoke(controller, "use-custom");
    assert.equal(field(controller, "custom").value, " draft ");
    confirmEnabled(controller, true);
  }
});

test("dismiss keeps confirmed answers", config, () => {
  for (const confirmed of [false, true]) {
    const controller = createQuestionnaireController({
      questions: [question, question],
    });
    change(controller, "choice", "option:0");
    if (confirmed) {
      invoke(controller, "confirm");
      invoke(controller, "use-custom");
      change(controller, "custom", "unconfirmed");
    }
    const lastView = controller.getView();
    const result = send(controller, { type: "dismiss" }).result;
    assert.equal(result?.cancelled, true);
    assert.equal(result?.answers.length, confirmed ? 1 : 0);
    assert.deepEqual(controller.getView(), lastView);
    assert.throws(
      () => send(controller, { type: "dismiss" }),
      /Questionnaire already completed\./,
    );
  }
});

test("caller mutation cannot change controller state", config, () => {
  const params = structuredClone({ questions: [question] });
  const controller = createQuestionnaireController(params);
  const initial = controller.getView();
  params.questions[0].question = "Changed outside controller";
  params.questions[0].options[0].label = "Changed outside controller";
  initial.root.id = "changed-view";
  const choice = field(controller, "choice");
  assert.ok(choice.type === "single");
  choice.options[0].id = "changed-option";
  change(controller, "choice", "option:0");
  const result = invoke(controller, "confirm").result;
  assert.equal(result?.answers[0].question, question.question);
  assert.equal(result?.answers[0].answer, "A");
});

test("business modules have no frontend dependencies", config, () => {
  for (const path of ["./controller.ts", "./core.ts"]) {
    const source = readFileSync(new URL(path, import.meta.url), "utf8");
    assert.doesNotMatch(
      source,
      /@earendil-works\/pi-|ui\/(?:session|adapters)/,
    );
    assert.doesNotMatch(
      source,
      /register(?:Tool|Command)|\.ui\b|\.select\(|\.input\(/,
    );
  }
});

test("invalid events reject atomically", config, () => {
  const controller = createQuestionnaireController({ questions: [question] });
  const initial = controller.getView();
  const envelope = { viewId: initial.id, revision: initial.revision };
  const invalid: UIEvent[] = [
    { ...envelope, type: "invoke", nodeId: "confirm" },
    { ...envelope, type: "invoke", nodeId: "unknown" },
    { ...envelope, type: "invoke", nodeId: "use-options" },
    { ...envelope, type: "invoke", nodeId: "choice" },
    { ...envelope, type: "change", nodeId: "custom", value: "hidden" },
    { ...envelope, type: "change", nodeId: "choice", value: "option:99" },
    { ...envelope, type: "change", nodeId: "choice", value: ["option:0"] },
    { ...envelope, type: "dismiss", viewId: "wrong" },
    { ...envelope, type: "dismiss", revision: initial.revision + 1 },
  ];
  for (const event of invalid) {
    assert.throws(() => controller.handle(event));
    assert.deepEqual(controller.getView(), initial);
  }
  change(controller, "choice", "option:0");
  const current = controller.getView();
  assert.throws(() =>
    controller.handle({ ...envelope, type: "invoke", nodeId: "confirm" }),
  );
  assert.deepEqual(controller.getView(), current);
});
