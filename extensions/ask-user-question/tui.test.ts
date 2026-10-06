import assert from "node:assert/strict";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import type {
  ExtensionUIContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import {
  type Component,
  CURSOR_MARKER,
  compositeTuiLine,
  getKeybindings,
  type TUI,
  type TuiMouseEvent,
  visibleWidth,
} from "@earendil-works/pi-tui";
import {
  fillPanel as fillQuestionPanel,
  panelRule as questionPanelRule,
} from "../../shared/ui/panel.ts";
import { layoutTabs, tabAt as questionTabAt } from "../../shared/ui/tabs.ts";
import type { AskUserParams, AskUserResult } from "./core.ts";
import { askTabbedQuestions } from "./tui.ts";
import { questionnaireKeyAction } from "./ui/keys.ts";
import {
  createQuestionnaireState,
  type QuestionnaireAction,
  type QuestionnaireState,
  reduceQuestionnaire,
} from "./ui/state.ts";

function layoutQuestionTabs(state: QuestionnaireState, width: number) {
  return layoutTabs(
    [
      ...state.answers.map(
        (answer, index) => `[Q${index + 1}${answer ? " ✓" : ""}]`,
      ),
      "[Submit]",
    ],
    state.active,
    width,
  );
}

const params: AskUserParams = {
  questions: [
    {
      question: "Which approach?",
      options: [{ label: "A", description: "Simple" }, { label: "B" }],
    },
    { question: "Where?", options: [{ label: "Local" }] },
  ],
};

function stateDriver(value = params) {
  let state = createQuestionnaireState(value);
  return {
    get state() {
      return state;
    },
    act(action: QuestionnaireAction) {
      const next = reduceQuestionnaire(state, value, action);
      state = next.state;
      return next.result;
    },
  };
}

test("switching wraps through Submit, preserving highlights and drafts", () => {
  const driver = stateDriver();
  driver.act({ type: "move", delta: -1 });
  assert.equal(driver.state.selected[0], 2);
  driver.act({ type: "draft", value: " unfinished " });
  driver.act({ type: "switch", delta: 1 });
  driver.act({ type: "move", delta: 1 });
  driver.act({ type: "draft", value: "other" });
  driver.act({ type: "switch", delta: 1 });
  assert.equal(driver.state.active, 2);
  driver.act({ type: "switch", delta: 1 });
  assert.equal(driver.state.active, 0);
  assert.deepEqual(driver.state.drafts, [" unfinished ", "other"]);
  assert.deepEqual(driver.state.selected, [2, 1]);
  driver.act({ type: "switch", delta: -1 });
  assert.equal(driver.state.active, 2);
});

test("explicit confirmation replaces answers, and only complete review submits", () => {
  const driver = stateDriver();
  driver.act({ type: "tab", index: 2 });
  assert.equal(driver.act({ type: "confirm" }), undefined);
  driver.act({ type: "tab", index: 0 });
  driver.act({ type: "select", index: 1 });
  assert.equal(driver.act({ type: "confirm" }), undefined);
  assert.equal(driver.state.active, 1);
  assert.equal(driver.state.answers[0]?.optionIndex, 1);
  driver.act({ type: "select", index: 1 });
  driver.act({ type: "draft", value: " " });
  driver.act({ type: "confirm" });
  assert.equal(driver.state.active, 1);
  driver.act({ type: "draft", value: " my answer " });
  assert.equal(driver.act({ type: "confirm" }), undefined);
  assert.equal(driver.state.active, 2);
  driver.act({ type: "tab", index: 0 });
  driver.act({ type: "select", index: 0 });
  driver.act({ type: "confirm" });
  driver.act({ type: "tab", index: 2 });
  const result = driver.act({ type: "confirm" });
  assert.equal(result?.cancelled, false);
  assert.deepEqual(
    result?.answers.map((answer) => answer.answer),
    ["A", " my answer "],
  );
  assert.equal(result?.answers[1].kind, "custom");
  assert.equal(result?.answers[1].optionIndex, undefined);
});

test("cancel preserves confirmed answers in question order, not unconfirmed drafts", () => {
  const driver = stateDriver();
  driver.act({ type: "tab", index: 1 });
  driver.act({ type: "confirm" });
  driver.act({ type: "tab", index: 0 });
  driver.act({ type: "select", index: 2 });
  driver.act({ type: "draft", value: "unsent" });
  const result = driver.act({ type: "cancel" });
  assert.equal(result?.cancelled, true);
  assert.deepEqual(
    result?.answers.map((answer) => answer.questionIndex),
    [1],
  );
});

test("input maps only Tab and Shift+Tab to tabs even while editing", () => {
  for (const key of ["\t"]) {
    assert.deepEqual(questionnaireKeyAction(key), { type: "switch", delta: 1 });
  }
  for (const key of ["\x1b[Z"]) {
    assert.deepEqual(questionnaireKeyAction(key), {
      type: "switch",
      delta: -1,
    });
  }
  assert.deepEqual(questionnaireKeyAction("\r"), { type: "confirm" });
  assert.deepEqual(questionnaireKeyAction("\x1b"), { type: "cancel" });
  assert.equal(questionnaireKeyAction("draft"), undefined);
  assert.equal(questionnaireKeyAction("\x1b[C"), undefined);
  assert.equal(questionnaireKeyAction("\x1b[D"), undefined);
  assert.deepEqual(
    questionnaireKeyAction("configured", {
      matches: (data, action) =>
        data === "configured" && action === "tui.select.down",
    }),
    { type: "move", delta: 1 },
  );
});

type TestComponent = Component & { focused?: boolean; dispose?: () => void };
const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  underline: (text: string) => text,
} as Theme;
const tui = {
  terminal: { rows: 24 },
  mode: "fullscreen",
  requestRender() {},
} as unknown as TUI;

function testUI(
  interact: (component: TestComponent) => void,
  beforeFactory?: () => void,
  renderTheme = theme,
) {
  let component: TestComponent | undefined;
  let disposals = 0;
  const ui = {
    async custom<T>(
      factory: Parameters<ExtensionUIContext["custom"]>[0],
      options: Parameters<ExtensionUIContext["custom"]>[1],
    ): Promise<T> {
      assert.equal(options, undefined); // Dock in the editor, never overlay.
      beforeFactory?.();
      return new Promise<T>((resolve) => {
        let finished = false;
        const done = (result: unknown) => {
          if (finished) return;
          finished = true;
          component?.dispose?.();
          resolve(result as T);
        };
        const keys = getKeybindings() as Parameters<typeof factory>[2];
        const value = factory(tui, renderTheme, keys, done);
        assert.ok(!(value instanceof Promise));
        component = value as TestComponent;
        const dispose = component.dispose?.bind(component);
        component.dispose = () => {
          disposals++;
          dispose?.();
        };
        component.focused = true;
        if (!finished) interact(component);
      });
    },
  } as ExtensionUIContext;
  return {
    ui,
    get component() {
      return component;
    },
    get disposals() {
      return disposals;
    },
  };
}

const mouse = (
  type: TuiMouseEvent["type"],
  x: number,
  y = 1,
): TuiMouseEvent => ({
  type,
  button: "left",
  x,
  y,
  screenX: x,
  screenY: y,
  width: 80,
  height: 24,
  shift: false,
  ctrl: false,
  alt: false,
});

test("ui.custom cancellation preserves answers and disposes safely", async () => {
  const host = testUI((component) => {
    component.handleInput?.("\r");
    component.handleInput?.("\x1b");
    component.handleInput?.("\r"); // input after completion is ignored
  });
  const result = await askTabbedQuestions(host.ui, params);
  assert.equal(result.cancelled, true);
  assert.equal(result.answers.length, 1);
  assert.ok(host.disposals >= 1);
  host.component?.dispose?.(); // idempotent
});

test("custom drafts, Input focus, review and fullscreen mouse tabs work together", async () => {
  const host = testUI((component) => {
    component.handleInput?.("\x1b[A"); // wraps to custom
    component.handleInput?.("你好");
    assert.ok(
      component.render(80).some((line) => line.includes(CURSOR_MARKER)),
    );
    component.handleInput?.("\t");
    component.handleInput?.("\x1b[Z");
    assert.ok(component.render(80).some((line) => line.includes("你好")));
    component.handleInput?.("\r"); // confirm custom, next question
    component.render(80);
    assert.deepEqual(component.handleMouse?.(mouse("press", 3)), {
      handled: true,
      focus: true,
    });
    assert.ok(component.render(80).some((line) => line.includes("Where?")));
    component.handleMouse?.(mouse("click", 3)); // Q1
    assert.ok(
      component.render(80).some((line) => line.includes("Which approach?")),
    );
    component.handleInput?.("\t");
    component.handleInput?.("\r"); // second answer -> review, still open
    assert.ok(
      component.render(80).some((line) => line.includes("Ready to submit")),
    );
    component.handleInput?.("\r");
  });
  const result = await askTabbedQuestions(host.ui, params);
  assert.equal(result.cancelled, false);
  assert.deepEqual(
    result.answers.map((answer) => answer.answer),
    ["你好", "Local"],
  );
});

test("left and right move the custom-answer cursor without switching questions", async () => {
  const host = testUI((component) => {
    component.handleInput?.("\x1b[A"); // wraps to custom
    component.handleInput?.("abc");
    component.handleInput?.("\x1b[D");
    component.handleInput?.("X");
    component.handleInput?.("\x1b[C");
    component.handleInput?.("Y");
    assert.ok(
      component.render(80).some((line) => line.includes("Which approach?")),
    );
    component.handleInput?.("\r"); // confirm custom
    component.handleInput?.("\r"); // confirm second answer
    component.handleInput?.("\r"); // submit
  });
  const result = await askTabbedQuestions(host.ui, params);
  assert.equal(result.cancelled, false);
  assert.equal(result.answers[0].answer, "abXcY");
});

test("large option lists and Unicode render within narrow widths", async () => {
  const many: AskUserParams = {
    questions: [
      {
        question: "问题🙂".repeat(50),
        options: Array.from({ length: 200 }, (_, index) => ({
          label: `${index} 你好🙂`,
          description: "Detail".repeat(20),
        })),
      },
    ],
  };
  const host = testUI((component) => {
    for (let index = 0; index < 150; index++) {
      component.handleInput?.("\x1b[B");
    }
    for (const width of [1, 2, 7, 15, 80]) {
      const lines = component.render(width);
      assert.ok(lines.every((line) => visibleWidth(line) <= width));
      assert.ok(lines.length <= 24);
    }
    component.handleInput?.("\r");
    component.handleInput?.("\r");
  });
  const result = await askTabbedQuestions(host.ui, many);
  assert.equal(result.answers[0].optionIndex, 150);
});

test("half-screen panel keeps its title and prioritizes compact answers/cursor", async () => {
  const previousRows = tui.terminal.rows;
  const host = testUI((component) => {
    for (const rows of [2, 3, 4, 6, 8, 9, 10, 12, 14, 16, 18, 24, 60]) {
      Object.assign(tui.terminal, { rows });
      const lines = component.render(80);
      assert.equal(lines.length, Math.max(1, Math.floor(rows / 2)));
      assert.match(lines[0], /Questionnaire/);
      assert.doesNotMatch(lines[0], /\[Q1\]/);
      const height = Math.max(1, Math.floor(rows / 2));
      assert.equal(
        lines.some((line) => line.includes("[Q1]")),
        height >= 7,
      );
      if (height < 7) {
        assert.equal(component.handleMouse?.(mouse("click", 3)), undefined);
      }
      if (height >= 2) {
        assert.ok(lines.some((line) => line.includes("○ 1. A")));
      }
      component.handleInput?.("\x1b[A"); // custom row
      const customLines = component.render(80);
      assert.ok(customLines.length <= rows);
      assert.match(customLines[0], /Questionnaire/);
      if (rows >= 4) {
        assert.ok(customLines.some((line) => line.includes(CURSOR_MARKER)));
      }
      assert.ok(customLines.every((line) => visibleWidth(line) === 80));
      component.handleInput?.("\x1b[B"); // first option
    }
    component.handleInput?.("\x1b");
  });
  try {
    await askTabbedQuestions(host.ui, params);
  } finally {
    Object.assign(tui.terminal, { rows: previousRows });
  }
});

test("panel padding fills reserved rows and keeps footer at the bottom", () => {
  const lines = fillQuestionPanel(
    ["Tabs", "Question", "Answer", "Footer"],
    30,
    8,
  );
  assert.equal(lines.length, 8);
  assert.equal(lines.filter((line) => line.trim() === "Footer").length, 1);
  assert.equal(lines[6].trim(), "Answer");
  assert.equal(lines[7].trim(), "Footer");
  for (const line of lines) {
    assert.equal(visibleWidth(line), 30);
    const composed = compositeTuiLine(
      "OTHER PLUGIN STATUS AND FOOTER",
      line,
      0,
      30,
      30,
    );
    assert.doesNotMatch(composed, /OTHER PLUGIN/);
  }
});

test("details can be scrolled with Shift arrows", async () => {
  const long: AskUserParams = {
    questions: [
      {
        question:
          "First line\nSecond line\nThird line\nFourth line\nFifth line",
        options: [{ label: "A" }],
      },
    ],
  };
  const host = testUI((component) => {
    const initial = component.render(80);
    assert.ok(initial.some((line) => line.includes("First line")));
    assert.ok(initial.some((line) => line.includes("Shift+↑/↓ details")));
    assert.ok(initial.every((line) => !line.includes("⇧")));
    component.handleInput?.("\u001b[1;2B");
    assert.ok(
      component.render(80).some((line) => line.includes("Fourth line")),
    );
    component.handleInput?.("\u001b[1;2A");
    assert.ok(component.render(80).some((line) => line.includes("First line")));
    component.handleInput?.("\u001b");
  });
  await askTabbedQuestions(host.ui, long);
});

test("review has separate Submit and Cancel buttons with independent focus", () => {
  const driver = stateDriver();
  driver.act({ type: "tab", index: 2 });
  assert.equal(driver.act({ type: "confirm" }), undefined);
  driver.act({ type: "review", delta: 1 });
  assert.equal(driver.state.reviewIndex, 1);
  assert.equal(driver.state.buttonIndex, 0);
  driver.act({ type: "move", delta: 1 });
  assert.equal(driver.state.buttonIndex, 1);
  assert.equal(driver.state.reviewIndex, 1);
  assert.deepEqual(driver.act({ type: "confirm" }), {
    answers: [],
    cancelled: true,
  });
});

test("Cancel button preserves confirmed answers when activated by keyboard", async () => {
  const host = testUI((component) => {
    component.handleInput?.("\r");
    component.handleInput?.("\t"); // review
    const lines = component.render(80);
    assert.ok(lines.some((line) => line.includes("[ Submit ]")));
    assert.ok(lines.some((line) => line.includes("[ Cancel ]")));
    component.handleInput?.("\u001b[B"); // Cancel
    component.handleInput?.("\r");
  });
  const result = await askTabbedQuestions(host.ui, params);
  assert.equal(result.cancelled, true);
  assert.equal(result.answers.length, 1);
});

test("mouse Submit sends all answers without requiring another Enter", async () => {
  const host = testUI((component) => {
    component.handleInput?.("\r");
    component.handleInput?.("\r");
    const lines = component.render(80);
    const y = lines.findIndex((line) => line.includes("[ Submit ]"));
    component.handleMouse?.(mouse("click", 4, y));
  });
  const result = await askTabbedQuestions(host.ui, params);
  assert.equal(result.cancelled, false);
  assert.equal(result.answers.length, 2);
});

const multiParams: AskUserParams = {
  questions: [
    { ...params.questions[0], multiSelect: true },
    params.questions[1],
  ],
};

test("multi-select toggles independently, persists across tabs and requires a choice", () => {
  const driver = stateDriver(multiParams);
  assert.equal(driver.act({ type: "confirm" }), undefined);
  assert.equal(driver.state.active, 0);
  driver.act({ type: "toggle" });
  driver.act({ type: "move", delta: 1 });
  driver.act({ type: "toggle" });
  assert.deepEqual(driver.state.checked[0], [0, 1]);
  driver.act({ type: "switch", delta: 1 });
  driver.act({ type: "switch", delta: -1 });
  assert.deepEqual(driver.state.checked[0], [0, 1]);
  driver.act({ type: "confirm" });
  assert.equal(driver.state.answers[0]?.kind, "multi");
  assert.deepEqual(driver.state.answers[0]?.selected, ["A", "B"]);
  assert.deepEqual(driver.state.answers[0]?.optionIndices, [0, 1]);
  driver.act({ type: "tab", index: 0 });
  driver.act({ type: "toggle" }); // remove B, keep A
  driver.act({ type: "confirm" });
  assert.deepEqual(driver.state.answers[0]?.selected, ["A"]);
});

test("unconfirmed checkboxes are not answers, and Space on single-select is ignored", () => {
  const driver = stateDriver(multiParams);
  driver.act({ type: "toggle" });
  assert.deepEqual(driver.act({ type: "cancel" }), {
    answers: [],
    cancelled: true,
  });
  driver.act({ type: "tab", index: 1 });
  driver.act({ type: "toggle" });
  assert.deepEqual(driver.state.checked[1], []);
});

test("multi-select custom answers replace checked answers without losing check drafts", () => {
  const driver = stateDriver(multiParams);
  driver.act({ type: "toggle" });
  driver.act({ type: "select", index: 2 });
  driver.act({ type: "toggle" }); // custom row is not a checkbox
  driver.act({ type: "draft", value: "custom instead" });
  driver.act({ type: "confirm" });
  assert.equal(driver.state.answers[0]?.kind, "custom");
  assert.equal(driver.state.answers[0]?.answer, "custom instead");
  assert.equal(driver.state.answers[0]?.selected, undefined);
  assert.deepEqual(driver.state.checked[0], [0]);
});

test("multi-select UI renders checks and returns mixed single/multi answers", async () => {
  const host = testUI((component) => {
    component.handleInput?.(" ");
    component.handleInput?.("\u001b[B");
    component.handleInput?.(" ");
    let lines = component.render(80);
    assert.ok(lines.some((line) => line.includes("[x] 1. A")));
    assert.ok(lines.some((line) => line.includes("[x] 2. B")));
    component.handleInput?.("\t");
    component.handleInput?.("\x1b[Z");
    lines = component.render(80);
    assert.ok(lines.some((line) => line.includes("[x] 2. B")));
    component.handleInput?.("\r");
    component.handleInput?.("\r");
    component.handleInput?.("\r");
  });
  const result = await askTabbedQuestions(host.ui, multiParams);
  assert.equal(result.cancelled, false);
  assert.equal(result.answers[0].kind, "multi");
  assert.deepEqual(result.answers[0].selected, ["A", "B"]);
  assert.equal(result.answers[1].kind, "option");
});

test("Space edits custom input rather than toggling a checkbox", async () => {
  const host = testUI((component) => {
    component.handleInput?.("\u001b[A"); // custom row
    component.handleInput?.("hello");
    component.handleInput?.(" ");
    component.handleInput?.("world");
    component.handleInput?.("\r");
    component.handleInput?.("\r");
    component.handleInput?.("\r");
  });
  const result = await askTabbedQuestions(host.ui, multiParams);
  assert.equal(result.answers[0].kind, "custom");
  assert.equal(result.answers[0].answer, "hello world");
});

test("pre-aborted signal never opens ui.custom", async () => {
  const controller = new AbortController();
  controller.abort();
  const host = testUI(() => assert.fail("unexpected UI"));
  await assert.rejects(askTabbedQuestions(host.ui, params, controller.signal), {
    name: "AbortError",
  });
  assert.equal(host.component, undefined);
});

test("abort while open closes UI, rejects, removes listener and disposes", async () => {
  const controller = new AbortController();
  let listeners = 0;
  const add = controller.signal.addEventListener.bind(controller.signal);
  const remove = controller.signal.removeEventListener.bind(controller.signal);
  controller.signal.addEventListener = (
    type: string,
    callback: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ) => {
    listeners++;
    add(type, callback, options);
  };
  controller.signal.removeEventListener = (
    type: string,
    callback: EventListenerOrEventListenerObject,
    options?: boolean | EventListenerOptions,
  ) => {
    listeners--;
    remove(type, callback, options);
  };
  const host = testUI((component) => {
    component.handleInput?.("\r");
    controller.abort();
  });
  await assert.rejects(askTabbedQuestions(host.ui, params, controller.signal), {
    name: "AbortError",
  });
  assert.equal(listeners, 0);
  assert.ok(host.disposals >= 1);
});

test("abort before factory invocation and host errors also clean up", async () => {
  const controller = new AbortController();
  const host = testUI(
    () => assert.fail("UI already aborted"),
    () => controller.abort(),
  );
  await assert.rejects(askTabbedQuestions(host.ui, params, controller.signal), {
    name: "AbortError",
  });
  assert.ok(host.disposals >= 1);
  const broken = {
    async custom<T>(): Promise<T> {
      throw new Error("host failure");
    },
  } as unknown as ExtensionUIContext;
  await assert.rejects(askTabbedQuestions(broken, params), /host failure/);
});

test("wrapper permits partial cancellation, never partial successful submission", async () => {
  const host = testUI((component) => {
    component.handleInput?.("\x1b[Z"); // Submit
    component.handleInput?.("\r"); // blocked
    assert.ok(
      component.render(80).some((line) => line.includes("0/2 confirmed")),
    );
    component.handleInput?.("\x1b");
  });
  const result: AskUserResult = await askTabbedQuestions(host.ui, params);
  assert.deepEqual(result, { answers: [], cancelled: true });
});

const styledTheme = {
  fg: (color: string, text: string) => {
    const codes: Record<string, number> = {
      accent: 36,
      muted: 90,
      dim: 2,
      warning: 33,
      success: 32,
    };
    return `\x1b[${codes[color] ?? 37}m${text}\x1b[0m`;
  },
  bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
  underline: (text: string) => `\x1b[4m${text}\x1b[24m`,
} as Theme;

const plain = stripVTControlCharacters;

test("stepped form separates bold title, choices and selected description", async () => {
  const described: AskUserParams = {
    questions: [
      {
        question: "Pick a strategy",
        options: [
          { label: "Fast", description: "Fast detail only" },
          { label: "Careful", description: "Careful detail only" },
        ],
      },
    ],
  };
  const host = testUI(
    (component) => {
      const styled = component.render(80);
      const lines = styled.map(plain);
      assert.ok(styled.some((line) => line.includes("\x1b[1mPick a strategy")));
      assert.ok(
        lines.some((line) =>
          line.includes("Question 1/1 · 0/1 confirmed · Choose one"),
        ),
      );
      assert.ok(lines.some((line) => line.includes("○ 1. Fast")));
      assert.ok(lines.some((line) => line.includes("○ 2. Careful")));
      assert.equal(
        lines.filter((line) => line.includes("Fast detail only")).length,
        1,
      );
      assert.ok(!lines.some((line) => line.includes("Careful detail only")));
      const detailY = lines.findIndex((line) =>
        line.includes("Fast detail only"),
      );
      assert.ok(
        detailY > lines.findIndex((line) => line.includes("○ 2. Careful")),
      );
      assert.ok(!lines[detailY].includes("Pick a strategy"));
      assert.ok(styled.at(-2)?.startsWith("\x1b[90m"));
      assert.ok(lines.at(-2)?.includes("Enter confirm"));
      assert.ok(!lines.at(-2)?.includes("Space toggle"));
      assert.equal(lines.at(-1), "─".repeat(80));
      component.handleInput?.("\x1b[B");
      const moved = component.render(80).map(plain);
      assert.ok(!moved.some((line) => line.includes("Fast detail only")));
      assert.equal(
        moved.filter((line) => line.includes("Careful detail only")).length,
        1,
      );
      component.handleInput?.("\x1b");
    },
    undefined,
    styledTheme,
  );
  await askTabbedQuestions(host.ui, described);
});

test("custom answer label and contextual footer stay consistent without confirming drafts", async () => {
  const previousRows = tui.terminal.rows;
  const host = testUI((component) => {
    assert.ok(
      component.render(80).some((line) => line.includes("○ Custom answer")),
    );
    component.handleInput?.("\x1b[A");
    component.handleInput?.("draft");
    const lines = component.render(80);
    assert.ok(
      lines.some((line) =>
        line.includes("Custom answer · single line, not blank"),
      ),
    );
    assert.ok(lines.some((line) => line.includes("0/2 confirmed")));
    assert.ok(lines.at(-2)?.includes("←→ cursor"));
    assert.ok(!lines.at(-2)?.includes("↑↓ choose"));
    assert.equal(lines.at(-1), "─".repeat(80));
    assert.ok(!lines.some((line) => line.includes("Type something")));
    Object.assign(tui.terminal, { rows: 12 });
    assert.ok(
      component.render(80).some((line) => line.includes(CURSOR_MARKER)),
    );
    component.focused = false;
    assert.ok(
      !component.render(80).some((line) => line.includes(CURSOR_MARKER)),
    );
    component.focused = true;
    component.handleInput?.("\r");
    Object.assign(tui.terminal, { rows: 24 });
    assert.ok(
      component.render(80).some((line) => line.includes("1/2 confirmed")),
    );
    component.handleInput?.("\x1b");
  });
  try {
    await askTabbedQuestions(host.ui, params);
  } finally {
    Object.assign(tui.terminal, { rows: previousRows });
  }
});

test("review exposes missing count and subdued Submit without widening mouse bounds", async () => {
  const host = testUI(
    (component) => {
      component.handleInput?.("\x1b[Z");
      let lines = component.render(80);
      assert.ok(
        lines
          .map(plain)
          .some((line) => line.includes("Review · 0/2 confirmed · 2 missing")),
      );
      const submitY = lines.findIndex((line) => line.includes("[ Submit ]"));
      assert.ok(lines[submitY].includes("\x1b[2m[ Submit ] (incomplete)"));
      const bound = visibleWidth(plain(lines[submitY]).trimEnd());
      assert.equal(
        component.handleMouse?.(mouse("click", -1, submitY)),
        undefined,
      );
      assert.equal(
        component.handleMouse?.(mouse("click", bound, submitY)),
        undefined,
      );
      assert.equal(
        component.handleMouse?.(mouse("click", 4, submitY + 2)),
        undefined,
      );
      component.handleMouse?.(mouse("click", bound - 1, submitY));
      assert.ok(
        component
          .render(80)
          .map(plain)
          .some((line) => line.includes("2 missing")),
      );
      component.handleInput?.("\t"); // first question
      component.handleInput?.("\r");
      component.handleInput?.("\t"); // review
      lines = component.render(80);
      assert.ok(
        lines
          .map(plain)
          .some((line) => line.includes("1/2 confirmed · 1 missing")),
      );
      component.handleInput?.("\x1b[6~"); // next review answer
      assert.ok(
        component.render(80).some((line) => line.includes("Not answered")),
      );
      component.handleInput?.("\x1b[Z"); // second question
      component.handleInput?.("\r");
      lines = component.render(80);
      assert.ok(lines.some((line) => line.includes("Ready to submit")));
      assert.ok(
        lines.some((line) => line.includes("\x1b[36m[ Submit ]\x1b[0m")),
      );
      assert.ok(
        !lines.some(
          (line) => line.includes("missing") || line.includes("incomplete"),
        ),
      );
      component.handleInput?.("\r");
    },
    undefined,
    styledTheme,
  );
  assert.equal((await askTabbedQuestions(host.ui, params)).cancelled, false);
});

test("styled long Unicode titles and details fit all half-screen sizes including review", async () => {
  const previousRows = tui.terminal.rows;
  const unicode: AskUserParams = {
    questions: [
      {
        question: "标题🙂é".repeat(30),
        options: [
          {
            label: "选项👩‍💻".repeat(20),
            description: "说明界🙂é".repeat(40),
          },
        ],
      },
    ],
  };
  const host = testUI(
    (component) => {
      for (const rows of [2, 4, 8, 12, 18, 24, 60]) {
        Object.assign(tui.terminal, { rows });
        for (const width of [1, 2, 7, 15, 40, 80]) {
          for (const key of ["", "\x1b[1;2B", "\x1b[1;2A"]) {
            if (key) component.handleInput?.(key);
            const lines = component.render(width);
            assert.equal(lines.length, Math.max(1, Math.floor(rows / 2)));
            assert.ok(lines.every((line) => visibleWidth(line) === width));
          }
        }
      }
      component.handleInput?.("\r");
      for (const width of [1, 2, 7, 15, 80]) {
        assert.ok(
          component.render(width).every((line) => visibleWidth(line) === width),
        );
      }
      component.handleInput?.("\r");
    },
    undefined,
    styledTheme,
  );
  try {
    await askTabbedQuestions(host.ui, unicode);
  } finally {
    Object.assign(tui.terminal, { rows: previousRows });
  }
});

test("multi-select footer distinguishes checked drafts from confirmed progress", async () => {
  const host = testUI((component) => {
    component.handleInput?.(" ");
    const lines = component.render(80);
    assert.ok(lines.some((line) => line.includes("[x] 1. A")));
    assert.ok(
      lines.some((line) => line.includes("0/2 confirmed · Choose many")),
    );
    assert.ok(
      lines.some((line) => line.includes("1 selected · Enter to confirm")),
    );
    assert.ok(lines.at(-2)?.includes("Space toggle"));
    assert.equal(lines.at(-1), "─".repeat(80));
    component.handleInput?.("\r");
    assert.ok(
      component.render(80).some((line) => line.includes("1/2 confirmed")),
    );
    component.handleInput?.("\x1b");
  });
  await askTabbedQuestions(host.ui, multiParams);
});

test("selected description scrolls independently of the title and survives compact layout", async () => {
  const previousRows = tui.terminal.rows;
  const detailed: AskUserParams = {
    questions: [
      {
        question: "Stable title",
        options: [
          {
            label: "Choice",
            description: "Detail one\nDetail two\nDetail three\nDetail four",
          },
        ],
      },
    ],
  };
  const host = testUI((component) => {
    const details = ["Detail one", "Detail two", "Detail three", "Detail four"];
    for (const rows of [12, 24]) {
      Object.assign(tui.terminal, { rows });
      for (const [index, detail] of details.entries()) {
        const lines = component.render(80);
        assert.ok(lines.some((line) => line.includes(detail)));
        assert.equal(
          lines.filter((line) => line.includes("Detail ")).length,
          1,
        );
        assert.ok(lines.some((line) => line.includes("Stable title")));
        if (index < details.length - 1) component.handleInput?.("\x1b[1;2B");
      }
      for (const detail of details.slice(0, -1).reverse()) {
        component.handleInput?.("\x1b[1;2A");
        assert.ok(component.render(80).some((line) => line.includes(detail)));
      }
    }
    Object.assign(tui.terminal, { rows: 12 });
    const lines = component.render(80);
    assert.ok(lines.some((line) => line.includes("Detail one")));
    assert.ok(lines.some((line) => line.includes("○ 1. Choice")));
    assert.ok(lines.some((line) => line.includes("0/1 confirmed")));
    component.handleInput?.("\x1b");
  });
  try {
    await askTabbedQuestions(host.ui, detailed);
  } finally {
    Object.assign(tui.terminal, { rows: previousRows });
  }
});

test("short review keeps the selected answer above pinned mouse buttons", async () => {
  const previousRows = tui.terminal.rows;
  const long: AskUserParams = {
    questions: [
      {
        question: "Long title\nSecond line\nThird line",
        options: [{ label: "Chosen" }],
      },
      params.questions[1],
    ],
  };
  const host = testUI((component) => {
    component.handleInput?.("\r");
    component.handleInput?.("\t");
    for (const rows of [12, 14, 16, 18]) {
      Object.assign(tui.terminal, { rows });
      const lines = component.render(80);
      assert.ok(lines.some((line) => line.includes("Long title")));
      assert.ok(lines.some((line) => line.includes("Chosen")));
      assert.ok(lines.every((line) => !line.includes("\n")));
      const pinned = rows >= 18 ? 4 : 3;
      assert.ok(lines[lines.length - pinned].includes("[ Submit ]"));
      assert.ok(lines[lines.length - pinned + 1].includes("[ Cancel ]"));
      assert.equal(lines.at(-1), "─".repeat(80));
      assert.equal(
        lines.some((line) => line.includes("PgUp/PgDn answers")),
        rows >= 18,
      );
      if (rows < 18) {
        component.handleInput?.("\x1b[6~");
        const next = component.render(80);
        assert.ok(next.some((line) => line.includes("Where?")));
        assert.ok(next.some((line) => line.includes("Not answered")));
        component.handleInput?.("\x1b[5~");
      }
    }
    component.handleInput?.("\x1b");
  });
  try {
    await askTabbedQuestions(host.ui, long);
  } finally {
    Object.assign(tui.terminal, { rows: previousRows });
  }
});

test("questionnaire boundaries use semantic theme paint at every dock size", async () => {
  const previousRows = tui.terminal.rows;
  let accent = 205;
  const boundaryTheme = {
    ...styledTheme,
    fg: (color: string, text: string) => {
      const code = color === "accent" ? accent : color === "muted" ? 244 : 250;
      return `\x1b[38;5;${code}m${text}\x1b[39m`;
    },
  } as Theme;
  const host = testUI(
    (component) => {
      for (const mode of ["question", "custom", "review"]) {
        if (mode === "custom") component.handleInput?.("\x1b[A");
        if (mode === "review") component.handleInput?.("\x1b[Z");
        const active = mode === "review" ? 2 : 0;
        for (const rows of [
          ...Array.from({ length: 20 }, (_, i) => i + 1),
          24,
          60,
        ]) {
          Object.assign(tui.terminal, { rows });
          for (const width of [1, 2, 3, 4, 7, 15, 40, 80]) {
            const lines = component.render(width);
            const height = Math.max(1, Math.floor(rows / 2));
            assert.equal(lines.length, height);
            assert.ok(lines.every((line) => visibleWidth(line) === width));
            const topRule = questionPanelRule(width, "Questionnaire", (text) =>
              boundaryTheme.fg("accent", boundaryTheme.bold(text)),
            );
            assert.equal(plain(lines[0]), plain(topRule));
            assert.ok(lines[0].includes(topRule));
            assert.doesNotMatch(plain(lines[0]), /\[Q|\[Submit\]/);
            if (height >= 7) {
              const tabs = layoutQuestionTabs(
                { ...createQuestionnaireState(params), active },
                width,
              );
              const tab = tabs.find((item) => item.index === active);
              assert.ok(tab);
              assert.ok(
                lines[1].includes(
                  boundaryTheme.fg("accent", boundaryTheme.bold(tab.label)),
                ),
              );
              assert.ok(!plain(lines[1]).includes("─"));
            } else {
              assert.ok(
                !lines.some((line) => /\[Q|\[Submit\]/.test(plain(line))),
              );
            }
            for (let x = 0; x < width; x++) {
              assert.equal(
                component.handleMouse?.(mouse("click", x, 0)),
                undefined,
              );
            }
            const bottom = lines.at(-1);
            assert.ok(bottom);
            if (height >= 3) {
              assert.equal(plain(bottom), "─".repeat(width));
              assert.equal(
                bottom,
                boundaryTheme.fg("accent", "─".repeat(width)),
              );
              if (width === 80 && height >= 9) {
                const hint = lines.at(-2);
                assert.ok(hint);
                assert.ok(hint.startsWith("\x1b[38;5;244m"));
                assert.ok(hint.includes("Enter"));
                assert.ok(!plain(hint).includes("─"));
              } else if (height < 9) {
                assert.ok(!lines.some((line) => line.includes("Enter")));
              }
            } else {
              assert.ok(bottom.startsWith("\x1b[4m"));
              assert.ok(bottom.endsWith("\x1b[24m"));
            }
            if (mode === "custom" && height >= 2 && width === 80) {
              assert.ok(lines.some((line) => line.includes(CURSOR_MARKER)));
            }
          }
        }
      }
      Object.assign(tui.terminal, { rows: 24 });
      assert.ok(
        component
          .render(80)
          .some((line) =>
            line.includes(boundaryTheme.fg("muted", "Review · 0/2 confirmed")),
          ),
      );
      const before = component.render(80);
      accent = 117; // A different active palette must repaint both boundaries.
      component.invalidate();
      const after = component.render(80);
      assert.notEqual(after[0], before[0]);
      assert.notEqual(after.at(-1), before.at(-1));
      assert.deepEqual(after.map(plain), before.map(plain));
      component.handleInput?.("\x1b");
    },
    undefined,
    boundaryTheme,
  );
  try {
    await askTabbedQuestions(host.ui, params);
  } finally {
    Object.assign(tui.terminal, { rows: previousRows });
  }
});

test("separate tabs keep layout offsets and row-one mouse targets, not rule/title cells", async () => {
  const many: AskUserParams = {
    questions: Array.from({ length: 12 }, () => params.questions[0]),
  };
  const driver = stateDriver(many);
  const host = testUI(
    (component) => {
      for (let i = 0; i < 6; i++) {
        component.handleInput?.("\t");
        driver.act({ type: "switch", delta: 1 });
      }
      for (const width of [1, 2, 7, 15, 40, 80]) {
        const tabs = layoutQuestionTabs(driver.state, width);
        const tabRow = plain(component.render(width)[1]);
        for (const tab of tabs) {
          assert.equal(
            tabRow.slice(tab.x, tab.x + tab.width),
            plain(tab.label),
          );
        }
        for (let x = 0; x < width; x++) {
          if (questionTabAt(tabs, x, 0) === undefined) {
            assert.equal(component.handleMouse?.(mouse("click", x)), undefined);
          }
        }
        const target =
          tabs.find((tab) => tab.index !== driver.state.active) ?? tabs[0];
        assert.equal(
          component.handleMouse?.(mouse("click", target.x, 0)),
          undefined,
        );
        assert.deepEqual(component.handleMouse?.(mouse("press", target.x)), {
          handled: true,
          focus: true,
        });
        assert.equal(plain(component.render(width)[1]), tabRow);
        component.handleMouse?.(mouse("click", target.x));
        driver.act({ type: "tab", index: target.index });
        const activeTab = layoutQuestionTabs(driver.state, width).find(
          (tab) => tab.index === driver.state.active,
        );
        assert.ok(activeTab);
        assert.ok(
          component
            .render(width)[1]
            .includes(
              styledTheme.fg("accent", styledTheme.bold(activeTab.label)),
            ),
        );
        assert.equal(component.handleMouse?.(mouse("click", -1)), undefined);
        assert.equal(component.handleMouse?.(mouse("click", width)), undefined);
      }
      component.handleInput?.("\x1b");
    },
    undefined,
    styledTheme,
  );
  await askTabbedQuestions(host.ui, many);
});

test("review mouse bounds follow pinned controls across the hint-row threshold", async () => {
  const previousRows = tui.terminal.rows;
  const host = testUI((component) => {
    component.handleInput?.("\x1b[Z"); // incomplete review
    for (const height of [4, 5, 6, 7, 8, 9, 12, 30]) {
      Object.assign(tui.terminal, { rows: height * 2 });
      for (const width of [7, 15, 40, 80]) {
        const lines = component.render(width);
        const pinned = height >= 9 ? 4 : 3;
        const submitY = height - pinned;
        const cancelY = submitY + 1;
        assert.match(lines[submitY], /Sub/);
        assert.match(lines[cancelY], /Can/);
        for (const y of [submitY, cancelY]) {
          const bound = visibleWidth(lines[y].trimEnd());
          assert.equal(
            component.handleMouse?.(mouse("click", -1, y)),
            undefined,
          );
          assert.equal(
            component.handleMouse?.(mouse("click", bound, y)),
            undefined,
          );
          assert.deepEqual(
            component.handleMouse?.(mouse("press", bound - 1, y)),
            {
              handled: true,
              focus: true,
            },
          );
        }
        for (let y = cancelY + 1; y < height; y++) {
          assert.equal(
            component.handleMouse?.(mouse("click", 0, y)),
            undefined,
          );
        }
        assert.deepEqual(component.handleMouse?.(mouse("click", 0, submitY)), {
          handled: true,
          focus: true,
        }); // incomplete Submit must not close
      }
    }
    const lines = component.render(80);
    const cancelY = lines.findIndex((line) => line.includes("[ Cancel ]"));
    assert.deepEqual(component.handleMouse?.(mouse("click", 4, cancelY)), {
      handled: true,
      focus: false,
    });
  });
  try {
    assert.equal((await askTabbedQuestions(host.ui, params)).cancelled, true);
  } finally {
    Object.assign(tui.terminal, { rows: previousRows });
  }
});

test("custom IME cursor stays above the rule and optional hint within panel bounds", async () => {
  const previousRows = tui.terminal.rows;
  const host = testUI((component) => {
    component.handleInput?.("\x1b[A");
    component.handleInput?.("你好🙂".repeat(30));
    for (const height of [2, 3, 4, 6, 8, 9, 12, 30]) {
      Object.assign(tui.terminal, { rows: height * 2 });
      for (const width of [7, 15, 80]) {
        const lines = component.render(width);
        const cursorY = lines.findIndex((line) => line.includes(CURSOR_MARKER));
        assert.equal(cursorY, height < 3 ? 1 : height - (height >= 9 ? 3 : 2));
        const cursorX = visibleWidth(lines[cursorY].split(CURSOR_MARKER)[0]);
        assert.ok(cursorX >= 0 && cursorX < width);
        assert.ok(lines.every((line) => visibleWidth(line) === width));
        if (height >= 3) assert.equal(lines.at(-1), "─".repeat(width));
        if (width === 80) {
          assert.equal(
            lines.some((line) => line.includes("←→ cursor")),
            height >= 9,
          );
        }
      }
    }
    component.handleInput?.("\x1b");
  });
  try {
    await askTabbedQuestions(host.ui, params);
  } finally {
    Object.assign(tui.terminal, { rows: previousRows });
  }
});
