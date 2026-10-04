import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  Input,
  type KeybindingsManager,
  matchesKey,
  SelectList,
  Text,
  type TUI,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import { DockedPanelFrame } from "../../../shared/ui/docked-panel/frame.ts";
import {
  dockedContentBudget,
  dockedContentWindow,
  dockedListBudget,
  dockedPanelLayout,
} from "../../../shared/ui/docked-panel/layout.ts";
import { layoutTabs, type TabLayout, tabAt } from "../../../shared/ui/tabs.ts";
import type { AskUserParams, AskUserResult } from "../core.ts";
import { questionnaireKeyAction } from "./keys.ts";
import {
  createQuestionnaireState,
  type QuestionnaireAction,
  type QuestionnaireState,
  reduceQuestionnaire,
} from "./state.ts";

export class TabbedQuestionnaire implements Component {
  focused = false;
  private state: QuestionnaireState;
  private readonly inputs = new Map<number, Input>();
  private tabs: TabLayout[] = [];
  private list?: SelectList;
  private listKey = "";
  private detailOffset = 0;
  private finished = false;
  private buttons: { index: number; y: number; width: number }[] = [];

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly keybindings: KeybindingsManager,
    private readonly params: AskUserParams,
    private readonly done: (result: AskUserResult) => void,
  ) {
    this.state = createQuestionnaireState(params);
  }

  cancel(): void {
    this.apply({ type: "cancel" });
  }

  dispose(): void {
    this.finished = true;
    for (const input of this.inputs.values()) input.focused = false;
    this.inputs.clear();
    this.tabs = [];
    this.buttons = [];
    this.list = undefined;
  }

  invalidate(): void {
    this.list?.invalidate();
    for (const input of this.inputs.values()) input.invalidate();
  }

  private apply(action: QuestionnaireAction): void {
    if (this.finished) return;
    const next = reduceQuestionnaire(this.state, this.params, action);
    this.state = next.state;
    if (action.type !== "draft") this.detailOffset = 0;
    if (next.result) {
      this.finished = true;
      this.done(next.result);
    } else {
      this.tui.requestRender();
    }
  }

  private input(): Input {
    let input = this.inputs.get(this.state.active);
    if (!input) {
      input = new Input({ placeholder: "Custom answer (not blank)" });
      input.setValue(this.state.drafts[this.state.active]);
      this.inputs.set(this.state.active, input);
    }
    return input;
  }

  handleInput(data: string): void {
    if (this.finished) return;
    if (data.startsWith("\x1b[<")) {
      return; // Mouse reports must never reach the custom-answer Input.
    }
    const question = this.params.questions[this.state.active];
    const custom =
      question &&
      this.state.selected[this.state.active] === question.options.length;
    const action = questionnaireKeyAction(data, this.keybindings);
    if (action?.type === "toggle" && custom) {
      const input = this.input();
      input.handleInput(data);
      this.apply({ type: "draft", value: input.getValue() });
    } else if (action) {
      this.apply(action);
    } else if (matchesKey(data, "shift+up") || matchesKey(data, "shift+down")) {
      // Scroll one line so even the smallest detail viewport skips no content.
      this.detailOffset = Math.max(
        0,
        this.detailOffset + (matchesKey(data, "shift+up") ? -1 : 1),
      );
      this.tui.requestRender();
    } else if (
      this.state.active === this.params.questions.length &&
      (matchesKey(data, "pageUp") || matchesKey(data, "pageDown"))
    ) {
      this.apply({
        type: "review",
        delta: matchesKey(data, "pageUp") ? -1 : 1,
      });
    } else {
      const question = this.params.questions[this.state.active];
      if (
        question &&
        this.state.selected[this.state.active] === question.options.length
      ) {
        const input = this.input();
        input.handleInput(data);
        this.apply({ type: "draft", value: input.getValue() });
      }
    }
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (this.finished) return undefined;
    const index = tabAt(this.tabs, event.x, event.y - 1);
    const button = this.buttons.find(
      (item) => event.y === item.y && event.x >= 0 && event.x < item.width,
    );
    if ((index === undefined && !button) || event.button !== "left")
      return undefined;
    // Consume press to avoid transcript selection; switch on click only, so a
    // press+click pair cannot activate two different tabs after re-layout.
    if (event.type === "press") return { handled: true, focus: true };
    if (event.type !== "click") return undefined;
    if (index !== undefined) {
      this.apply({ type: "tab", index });
    } else if (button) {
      this.apply({ type: "select", index: button.index });
      this.apply({ type: "confirm" });
    }
    // Completion restores editor focus synchronously; do not steal it back.
    return { handled: true, focus: !this.finished };
  }

  render(width: number): string[] {
    if (width < 1) {
      this.tabs = [];
      this.buttons = [];
      return [];
    }
    const { state, params } = this;
    const theme = this.theme;
    const question = params.questions[state.active];
    const answered = state.answers.filter(Boolean).length;
    const missing = params.questions.length - answered;
    const customLabel = "Custom answer";
    const custom =
      question && state.selected[state.active] === question.options.length;
    this.buttons = [];
    for (const [index, input] of this.inputs) {
      input.focused = this.focused && index === state.active && !!custom;
    }
    const layout = dockedPanelLayout(this.tui.terminal.rows, question ? 1 : 2);
    const { rows, showTabs, compact } = layout;
    const frame = new DockedPanelFrame(layout, width, theme, "Questionnaire");
    this.tabs = showTabs
      ? layoutTabs(
          [
            ...state.answers.map(
              (answer, index) => `[Q${index + 1}${answer ? " ✓" : ""}]`,
            ),
            "[Submit]",
          ],
          state.active,
          width,
        )
      : [];
    const heading = frame.heading(this.tabs, state.active);
    const selectedQuestion = question ?? params.questions[state.reviewIndex];
    const selectedOption = question?.options[state.selected[state.active]];
    const marker = (index: number) =>
      question?.multiSelect
        ? `${state.checked[state.active].includes(index) ? "[x]" : "[ ]"} `
        : "○ ";
    const optionLabel = (index: number) =>
      index === question?.options.length
        ? `○ ${customLabel}`
        : `${marker(index)}${index + 1}. ${question?.options[index].label}`;
    const progress = theme.fg(
      "muted",
      `${question ? `Question ${state.active + 1}/${params.questions.length}` : "Review"} · ${answered}/${params.questions.length} confirmed`,
    );
    const stepLine =
      progress +
      (question
        ? theme.fg(
            "dim",
            question.multiSelect ? " · Choose many" : " · Choose one",
          )
        : missing
          ? theme.fg("warning", ` · ${missing} missing`)
          : theme.fg("success", " · Ready to submit"));
    const buttonLines = ["[ Submit ]", "[ Cancel ]"].map((label, index) => {
      const focused = state.buttonIndex === index;
      return (
        theme.fg(focused ? "accent" : "dim", focused ? "❯ " : "  ") +
        theme.fg(
          index === 0 && missing ? "dim" : focused ? "accent" : "muted",
          `${label}${index === 0 && missing ? " (incomplete)" : ""}`,
        )
      );
    });
    const titleLines = new Text(
      theme.bold(selectedQuestion.question),
      0,
      0,
    ).render(width);
    // Descriptions belong only to the highlighted option, never to list rows.
    const detail = question
      ? custom
        ? `${customLabel} · single line, not blank`
        : (selectedOption?.description ?? "")
      : (state.answers[state.reviewIndex]?.answer ?? "Not answered");
    const detailLines = detail
      ? new Text(theme.fg("muted", detail), 0, 0).render(Math.max(1, width - 2))
      : [];
    const count = question
      ? question.options.length + 1
      : params.questions.length;
    const { titleHeight, detailHeight } = dockedContentBudget(
      layout,
      titleLines.length,
      detailLines.length,
      count,
    );
    const window = dockedContentWindow(
      titleLines,
      detailLines,
      titleHeight,
      detailHeight,
      this.detailOffset,
    );
    this.detailOffset = window.offset;
    const { title: titleView, detail: detailView } = window;
    const footerLabel = !question
      ? "↑↓ buttons · Enter · PgUp/PgDn answers · Esc cancel"
      : custom
        ? "←→/Tab steps · Enter confirm · Esc · Ctrl+B/F cursor"
        : question.multiSelect
          ? "←→/Tab steps · ↑↓ · Space toggle · Enter confirm · Esc"
          : "←→/Tab steps · ↑↓ choose · Enter confirm · Esc";
    const shortcut = `${footerLabel}${window.scrollable ? " · Shift+↑/↓ details" : ""}`;
    const finish = (content: string[]) => {
      if (!question)
        this.buttons = frame.controlBounds(buttonLines, content.length);
      return frame.finish(content, shortcut);
    };
    if (compact) {
      return finish([
        ...heading,
        ...frame.compactBody({
          progress: stepLine,
          title: titleView,
          detail: detailView,
          kind: !question ? "controls" : custom ? "input" : "value",
          active: () => {
            if (custom) {
              const input = this.input();
              input.focused = this.focused;
              return input.render(width);
            }
            if (!question)
              return rows >= 4 ? buttonLines : [buttonLines[state.buttonIndex]];
            return [
              theme.fg("accent", optionLabel(state.selected[state.active])),
            ];
          },
        }),
      ]);
    }
    const lines = [...heading, stepLine, ...titleView];
    const { budget: listBudget, visible } = dockedListBudget(
      layout,
      lines.length,
      detailView.length,
      count,
    );
    const listKey = `${state.active}:${visible}:${question?.multiSelect ? state.checked[state.active].join(",") : ""}`;
    if (this.listKey !== listKey || !this.list) {
      this.listKey = listKey;
      const items = question
        ? Array.from({ length: count }, (_, index) => ({
            value: `${index}`,
            label: optionLabel(index),
          }))
        : params.questions.map((item, index) => ({
            value: `${index}`,
            label: `${state.answers[index] ? "✓" : "○"} ${index + 1}. ${item.question.replace(/[\r\n]+/g, " ")}`,
          }));
      this.list = new SelectList(items, visible, {
        selectedPrefix: (text) => theme.fg("accent", text),
        selectedText: (text) => theme.fg("accent", theme.bold(text)),
        description: (text) => theme.fg("muted", text),
        scrollInfo: (text) => theme.fg("dim", text),
        noMatch: (text) => theme.fg("warning", text),
      });
    }
    this.list.setSelectedIndex(
      question ? state.selected[state.active] : state.reviewIndex,
    );
    // Omit the list (or its extra scroll indicator) when space is tight,
    // never displacing the selected description or review answer.
    lines.push(...this.list.render(width).slice(0, listBudget), ...detailView);
    if (custom) {
      const input = this.input();
      input.focused = this.focused;
      lines.push(...input.render(width));
    } else if (!question) {
      lines.push(...buttonLines);
    } else {
      lines.push(
        theme.fg(
          "muted",
          question.multiSelect
            ? `${state.checked[state.active].length} selected · Enter to confirm${state.answers[state.active] ? " · Previously confirmed" : ""}`
            : `Confirmed: ${state.answers[state.active]?.answer ?? "Not yet"}`,
        ),
      );
    }
    return finish(lines);
  }
}
