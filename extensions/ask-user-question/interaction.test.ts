import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import test, { type TestContext } from "node:test";
import {
  bindUIHost,
  type UIHost,
  type UIHostOutcome,
} from "@pi-kits/shared/ui/host";
import type { UISession } from "@pi-kits/shared/ui/session";
import { Value } from "typebox/value";
import {
  type AskUserParams,
  AskUserResultSchema,
  buildMultiAnswer,
  buildResponse,
} from "./core.ts";
import { askQuestions } from "./interaction.ts";

type Request = {
  kind: "select" | "input";
  title: string;
  labels: string[];
  signal: AbortSignal;
  answer(value?: string): void;
  reject(error: unknown): void;
};
function host() {
  const queued: Request[] = [];
  const active = new Set<Request>();
  let waiter: ((request: Request) => void) | undefined;
  let delayAbort = false;
  let calls = 0;
  const enqueue = (
    kind: Request["kind"],
    title: string,
    labels: string[],
    signal: AbortSignal | undefined,
  ) => {
    assert.ok(signal);
    calls++;
    assert.ok(calls <= 60, "Unexpected dialog loop");
    return new Promise<string | undefined>((resolve, reject) => {
      const cleanup = () => {
        active.delete(request);
        signal.removeEventListener("abort", abort);
      };
      const answer = (value?: string) => {
        cleanup();
        resolve(value);
      };
      const abort = () => {
        if (!delayAbort) answer();
      };
      const request: Request = {
        kind,
        title,
        labels,
        signal,
        answer,
        reject(error) {
          cleanup();
          reject(error);
        },
      };
      active.add(request);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      if (waiter) {
        const notify = waiter;
        waiter = undefined;
        notify(request);
      } else queued.push(request);
    });
  };
  const ui: Parameters<typeof bindUIHost>[0]["ui"] = {
    select: (title, labels, options) =>
      enqueue("select", title, labels, options?.signal),
    input: (title, _placeholder, options) =>
      enqueue("input", title, [], options?.signal),
  };
  return {
    ui,
    active,
    get calls() {
      return calls;
    },
    delayAbort() {
      delayAbort = true;
    },
    cleanup() {
      for (const request of active) request.answer();
    },
    async next() {
      const request = queued.shift();
      if (request) return request;
      assert.equal(waiter, undefined);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await new Promise<Request>((resolve, reject) => {
          waiter = resolve;
          timer = setTimeout(() => {
            waiter = undefined;
            reject(new Error("Expected dialog was not opened"));
          }, 700);
        });
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
const question = {
  question: "Which approach?",
  options: [{ label: "A", description: "Simple" }, { label: "B" }],
};
const config = { timeout: 3000 };
function start(
  t: TestContext,
  questions: AskUserParams["questions"] = [question],
  viewId?: string,
) {
  const h = host();
  const abort = new AbortController();
  const boundHost = bindUIHost({ hasUI: true, ui: h.ui });
  const outcomes: UIHostOutcome[] = [];
  const result = askQuestions(boundHost, { questions }, abort.signal, viewId, {
    onClosed(outcome) {
      outcomes.push(outcome);
    },
  });
  // Attach a rejection handler immediately, including before driving dialogs.
  const settled = result.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  t.after(async () => {
    abort.abort();
    h.cleanup();
    try {
      await settled;
    } finally {
      await boundHost.dispose();
    }
    assert.equal(h.active.size, 0);
    assert.equal(getEventListeners(abort.signal, "abort").length, 0);
  });
  return { h, abort, result, settled, outcomes };
}
function choose(request: Request, pattern: RegExp) {
  assert.equal(request.kind, "select");
  const label = request.labels.find((row) => pattern.test(row));
  assert.ok(label, `Missing ${pattern}: ${request.labels.join("; ")}`);
  request.answer(label);
}
async function editChoice(h: ReturnType<typeof host>, index: number) {
  const menu = await h.next();
  assert.match(menu.title, /\[\d\/\d\] Which approach\?/);
  choose(menu, /Edit:/);
  const choices = await h.next();
  assert.match(choices.labels[0], /A — Simple/);
  choices.answer(choices.labels[index]);
}
async function confirm(h: ReturnType<typeof host>) {
  choose(await h.next(), /Confirm/i);
}
function responseChecks(result: Awaited<ReturnType<typeof askQuestions>>) {
  const response = buildResponse(result);
  assert.deepEqual(response.details, result);
  assert.deepEqual(response.structuredContent, result);
  assert.ok(Value.Check(AskUserResultSchema, response.structuredContent));
  if (result.cancelled)
    assert.equal(response.content[0].text, "User cancelled");
}

test("sequential answers without review", config, async (t) => {
  const { h, result, outcomes } = start(
    t,
    [question, question],
    "dialog-instance",
  );
  await editChoice(h, 1);
  await confirm(h);
  await editChoice(h, 0);
  await confirm(h);
  const answer = await result;
  assert.deepEqual(answer, {
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
    cancelled: false,
  });
  assert.deepEqual(outcomes, [{ status: "completed" }]);
  assert.equal(h.calls, 6);
  assert.equal(h.active.size, 0);
  responseChecks(answer);
});

test("multi toggles, sorting and duplicates", config, async (t) => {
  const duplicate = {
    ...question,
    multiSelect: true,
    options: [...question.options, { label: "A" }],
  };
  const { h, result } = start(t, [duplicate]);
  choose(await h.next(), /Edit:/);
  let choices = await h.next();
  assert.equal(new Set(choices.labels).size, choices.labels.length);
  choices.answer(choices.labels[2]);
  choices = await h.next();
  assert.match(choices.labels[2], /\[x\] A/);
  choices.answer(choices.labels[0]);
  choices = await h.next();
  choose(choices, /Done/);
  await confirm(h);
  const answer = await result;
  assert.deepEqual(answer, {
    answers: [buildMultiAnswer(duplicate, 0, [2, 0])],
    cancelled: false,
  });
  responseChecks(answer);
});

test("blank drafts and literal custom text", config, async (t) => {
  const { h, result } = start(t, [{ ...question, multiSelect: true }]);
  let menu = await h.next();
  menu.answer(menu.labels[1]);
  for (const text of ["", " \n\t", " text: 123\n1,2 "]) {
    menu = await h.next();
    assert.ok(menu.labels.every((label) => !/Confirm/i.test(label)));
    choose(menu, /Edit:/);
    const input = await h.next();
    assert.equal(input.kind, "input");
    input.answer(text);
  }
  await confirm(h);
  const answer = await result;
  assert.deepEqual(answer, {
    answers: [
      {
        questionIndex: 0,
        question: question.question,
        kind: "custom",
        answer: " text: 123\n1,2 ",
      },
    ],
    cancelled: false,
  });
  responseChecks(answer);
});

test("inner back versus outer cancellation", config, async (t) => {
  const { h, result, outcomes } = start(t, [question, question]);
  await editChoice(h, 0);
  await confirm(h);
  let menu = await h.next();
  choose(menu, /Edit:/);
  (await h.next()).answer();
  menu = await h.next();
  assert.match(menu.title, /\[2\/2\]/);
  assert.ok(menu.labels.every((label) => !/Confirm/i.test(label)));
  menu.answer(menu.labels[1]);
  menu = await h.next();
  choose(menu, /Edit:/);
  const input = await h.next();
  assert.equal(input.kind, "input");
  input.answer();
  menu = await h.next();
  assert.match(menu.title, /\[2\/2\]/);
  menu.answer();
  const answer = await result;
  assert.deepEqual(answer, {
    answers: [
      {
        questionIndex: 0,
        question: question.question,
        kind: "option",
        answer: "A",
        optionIndex: 0,
      },
    ],
    cancelled: true,
  });
  assert.deepEqual(outcomes, [{ status: "dismissed" }]);
  responseChecks(answer);
});

test("multi back discards toggles", config, async (t) => {
  const { h, result } = start(t, [{ ...question, multiSelect: true }]);
  choose(await h.next(), /Edit:/);
  let choices = await h.next();
  choices.answer(choices.labels[0]);
  choices = await h.next();
  choices.answer();
  const menu = await h.next();
  assert.ok(menu.labels.every((label) => !/Confirm/i.test(label)));
  choose(menu, /Close/);
  assert.deepEqual(await result, { answers: [], cancelled: true });
});

test("host failures propagate after cleanup", config, async (t) => {
  for (const phase of ["select", "choice", "input", "unknown"]) {
    const { h, result } = start(t);
    const failure = new Error(phase);
    const rejection =
      phase === "unknown"
        ? assert.rejects(result, /unknown selection/)
        : assert.rejects(result, (error) => error === failure);
    let request = await h.next();
    if (phase === "choice") {
      choose(request, /Edit:/);
      request = await h.next();
    } else if (phase === "input") {
      request.answer(request.labels[1]);
      choose(await h.next(), /Edit:/);
      request = await h.next();
      assert.equal(request.kind, "input");
    }
    if (phase === "unknown") request.answer("not a menu item");
    else request.reject(failure);
    await rejection;
    assert.equal(h.active.size, 0);
  }
});

test("onClosed consumes only the public closed outcome", config, async () => {
  for (const reason of [
    new Error("custom abort"),
    { stop: true },
    "cancelled",
  ]) {
    const outcome: UIHostOutcome = { status: "aborted", error: reason };
    let onClosed: Parameters<UIHost["open"]>[1]["onClosed"];
    let resolve!: (outcome: UIHostOutcome) => void;
    const closed = new Promise<UIHostOutcome>((done) => {
      resolve = done;
    }).then(async (value) => {
      await onClosed?.(value);
      return value;
    });
    const unexpected = () => {
      throw new Error("Interaction must consume only session.closed");
    };
    const session: UISession = {
      closed,
      get signal(): AbortSignal {
        return unexpected();
      },
      getSnapshot: unexpected,
      subscribe: unexpected,
      dispatch: unexpected,
      publish: unexpected,
      close: unexpected,
    };
    let opens = 0;
    const publicHost: UIHost = {
      open(_view, options) {
        opens++;
        onClosed = options.onClosed;
        return session;
      },
      async dispose() {},
    };
    assert.deepEqual(Object.keys(publicHost).sort(), ["dispose", "open"]);
    const outcomes: UIHostOutcome[] = [];
    const result = askQuestions(
      publicHost,
      { questions: [question] },
      undefined,
      undefined,
      {
        onClosed(value) {
          outcomes.push(value);
        },
      },
    );
    const rejection = assert.rejects(result, (error) => error === reason);
    assert.equal(opens, 1);
    assert.deepEqual(outcomes, []);
    resolve(outcome);
    await rejection;
    assert.deepEqual(outcomes, [outcome]);
    assert.equal(outcomes[0], outcome);
  }
});

test("pre-abort skips dialogs", config, async (t) => {
  for (const reason of [
    undefined,
    new Error("pre-abort"),
    { cancelled: true },
  ]) {
    const h = host();
    const controller = new AbortController();
    const boundHost = bindUIHost({ hasUI: true, ui: h.ui });
    t.after(async () => {
      controller.abort();
      h.cleanup();
      await boundHost.dispose();
      assert.equal(h.active.size, 0);
      assert.equal(getEventListeners(controller.signal, "abort").length, 0);
    });
    controller.abort(reason);
    const outcomes: UIHostOutcome[] = [];
    await assert.rejects(
      askQuestions(
        boundHost,
        { questions: [question] },
        controller.signal,
        undefined,
        {
          onClosed(outcome) {
            outcomes.push(outcome);
          },
        },
      ),
      (error) => error === controller.signal.reason,
    );
    assert.deepEqual(outcomes, [
      { status: "aborted", error: controller.signal.reason },
    ]);
    assert.equal(h.calls, 0);
    if (reason === undefined)
      assert.equal(controller.signal.reason.name, "AbortError");
  }
});

test("abort propagates to local signals", config, async (t) => {
  for (const phase of ["menu", "choice", "input"]) {
    const { h, abort, result, outcomes } = start(t);
    const rejection = assert.rejects(result, { name: "AbortError" });
    let request = await h.next();
    if (phase === "choice") {
      choose(request, /Edit:/);
      request = await h.next();
    } else if (phase === "input") {
      request.answer(request.labels[1]);
      choose(await h.next(), /Edit:/);
      request = await h.next();
    }
    abort.abort();
    await rejection;
    assert.deepEqual(outcomes, [
      { status: "aborted", error: abort.signal.reason },
    ]);
    assert.equal(request.signal.aborted, true);
    assert.equal(h.active.size, 0);
  }
});

test("mode switching keeps choice and text drafts", config, async (t) => {
  const { h, result } = start(t);
  await editChoice(h, 1);
  let menu = await h.next();
  choose(menu, /Write custom answer/);
  choose(await h.next(), /Edit:/);
  (await h.next()).answer(" preserved draft ");
  menu = await h.next();
  choose(menu, /Choose options/);
  menu = await h.next();
  assert.match(menu.title, /Selected option: B/);
  choose(menu, /Write custom answer/);
  menu = await h.next();
  assert.ok(menu.title.includes("Custom answer:  preserved draft "));
  choose(menu, /Confirm/i);
  const answer = await result;
  assert.equal(answer.answers[0].kind, "custom");
  assert.equal(answer.answers[0].answer, " preserved draft ");
  responseChecks(answer);
});

test("host failure wins over abort during cleanup", config, async (t) => {
  const { h, abort, result, outcomes } = start(t);
  h.delayAbort();
  const request = await h.next();
  const failure = new Error("host failure during cleanup");
  const rejection = assert.rejects(result, (error) => error === failure);
  abort.abort(new Error("external abort"));
  assert.equal(request.signal.aborted, true);
  request.reject(failure);
  await rejection;
  assert.deepEqual(outcomes, [{ status: "aborted", error: failure }]);
  assert.equal(h.active.size, 0);
});

test("abort waits for cleanup", config, async (t) => {
  const { h, abort, result, settled, outcomes } = start(t);
  h.delayAbort();
  const request = await h.next();
  let done = false;
  void settled.then(() => {
    done = true;
  });
  const reason = new Error("stop questionnaire");
  const rejection = assert.rejects(result, (error) => error === reason);
  abort.abort(reason);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(request.signal.aborted, true);
  assert.equal(done, false);
  assert.deepEqual(outcomes, []);
  request.answer(request.labels[0]);
  await rejection;
  assert.deepEqual(outcomes, [{ status: "aborted", error: reason }]);
  assert.equal(h.calls, 1);
  assert.equal(h.active.size, 0);
});
