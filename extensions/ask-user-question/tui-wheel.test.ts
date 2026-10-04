import assert from "node:assert/strict";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import type {
  ExtensionUIContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import {
  type Component,
  Container,
  CURSOR_MARKER,
  getKeybindings,
  Input,
  ScrollView,
  type Terminal,
  Text,
  TuiAltScreen,
  TuiMainScreen,
  VStack,
  visibleWidth,
} from "@earendil-works/pi-tui";
import type { DockedPanelLifecycle } from "../../shared/ui/docked-panel/events.ts";
import type { AskUserParams } from "./core.ts";
import { askTabbedQuestions } from "./tui.ts";

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  underline: (text: string) => text,
} as Theme;
const params: AskUserParams = {
  questions: [
    {
      question: "Which approach?",
      options: [{ label: "A" }, { label: "B" }],
    },
  ],
};
const sgr = (button = 64, x = 1, y = 1, suffix = "M") =>
  `\x1b[<${button};${x};${y}${suffix}`;

class TestTerminal implements Terminal {
  columns = 80;
  rows = 24;
  kittyProtocolActive = false;
  private onInput?: (data: string) => void;
  private onResize?: () => void;
  start(onInput: (data: string) => void, onResize: () => void): void {
    this.onInput = onInput;
    this.onResize = onResize;
  }
  emit(data: string): void {
    assert.ok(this.onInput);
    this.onInput(data);
  }
  resize(columns: number, rows: number): void {
    this.columns = columns;
    this.rows = rows;
    this.onResize?.();
  }
  stop(): void {
    this.onInput = undefined;
    this.onResize = undefined;
  }
  async drainInput(): Promise<void> {}
  write(): void {}
  moveBy(): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(): void {}
  setProgress(): void {}
}

function mount(fullscreen = true) {
  const terminal = new TestTerminal();
  const host = fullscreen
    ? new TuiAltScreen(terminal, false, undefined, { wheelScrollLines: 3 })
    : new TuiMainScreen(terminal);
  const editor = new Input();
  editor.setValue("saved editor draft");
  const editorContainer = new Container();
  editorContainer.addChild(editor);
  const document = new Text(
    Array.from({ length: 100 }, (_, i) => `Transcript ${i}`).join("\n"),
    0,
    0,
  );
  const pending = new Text("Pending", 0, 0);
  const status = new Text("Status", 0, 0);
  const above = new Text("Widget above", 0, 0);
  const below = new Text("Widget below", 0, 0);
  const footer = new Text("Footer", 0, 0);
  // Matches installed Pi's createChatViewport: primary transcript plus a
  // shrinkable dock, including the editor's three-row minimum and widgets.
  const transcript = new ScrollView(document, {
    follow: "end",
    primary: true,
    overscroll: "chain",
    scrollbar: "hidden",
  });
  const dock = new VStack([
    { component: pending, shrink: 1, minSize: 0 },
    { component: status, shrink: 1, minSize: 0 },
    { component: above, shrink: 1, minSize: 0 },
    { component: editorContainer, shrink: 1, minSize: 3 },
    { component: below, shrink: 1, minSize: 0 },
    { component: footer, shrink: 1, minSize: 0 },
  ]);
  const root = new VStack([
    { component: transcript, basis: 0, grow: 1, shrink: 1, minSize: 1 },
    { component: dock, basis: "auto", grow: 0, shrink: 1, minSize: 1 },
  ]);
  if (host instanceof TuiAltScreen) host.setLayoutRoot(root);
  else {
    for (const child of [
      document,
      pending,
      status,
      above,
      editorContainer,
      below,
      footer,
    ]) {
      host.addChild(child);
    }
  }
  host.setFocus(editor);
  host.start();
  host.renderNow(true);

  let component: (Component & { dispose?: () => void }) | undefined;
  let disposals = 0;
  // Host-level contract harness, not a call into private InteractiveMode:
  // non-overlay custom replaces only the editor and restores it on done.
  const ui: Pick<ExtensionUIContext, "custom"> = {
    custom<T>(
      factory: Parameters<ExtensionUIContext["custom"]>[0],
      options: Parameters<ExtensionUIContext["custom"]>[1],
    ): Promise<T> {
      assert.equal(options, undefined);
      const savedText = editor.getValue();
      return new Promise<T>((resolve, reject) => {
        let closed = false;
        const restore = () => {
          editorContainer.clear();
          editorContainer.addChild(editor);
          editor.setValue(savedText);
          host.setFocus(editor);
          host.requestRender();
        };
        const done = (result: unknown) => {
          if (closed) return;
          closed = true;
          restore();
          resolve(result as T);
          component?.dispose?.();
          disposals++;
        };
        const keys = getKeybindings() as Parameters<typeof factory>[2];
        Promise.resolve(factory(host, theme, keys, done))
          .then((value) => {
            if (closed) return;
            component = value;
            editorContainer.clear();
            editorContainer.addChild(value);
            host.setFocus(value);
            host.requestRender();
          })
          .catch((error) => {
            restore();
            reject(error);
          });
      });
    },
  };
  return {
    terminal,
    host,
    editor,
    transcript,
    document,
    ui,
    get component() {
      assert.ok(component);
      return component;
    },
    get disposals() {
      return disposals;
    },
    async open(signal?: AbortSignal, lifecycle?: DockedPanelLifecycle) {
      const result = askTabbedQuestions(ui, params, signal, lifecycle);
      // Like Pi, custom mounts after resolving its component factory.
      await Promise.resolve();
      host.renderNow(true);
      return { result };
    },
    screen() {
      assert.ok(host instanceof TuiAltScreen);
      host.renderNow();
      return host.getScreenLines().map(stripVTControlCharacters);
    },
    stop() {
      component?.dispose?.();
      host.stop();
    },
  };
}

test("fullscreen editor dock reduces transcript viewport without overlapping rows", async () => {
  const driver = mount();
  try {
    const before = driver.transcript.viewportHeight;
    const { result } = await driver.open();
    const screen = driver.screen();
    const panelRows = driver.component.render(80);
    const panelY = screen.findIndex((line) => line.includes("Questionnaire"));
    assert.equal(panelRows.length, 12);
    assert.equal(driver.transcript.viewportHeight, before - 9);
    assert.equal(driver.transcript.viewportHeight, 7);
    assert.equal(panelY, driver.transcript.viewportHeight + 3);
    assert.deepEqual(screen.slice(panelY, panelY + 12), panelRows);
    assert.doesNotMatch(screen[panelY], /\[Q|\[Submit\]/);
    assert.match(screen[panelY + 1], /\[Q1\].*\[Submit\]/);
    assert.match(screen[panelY + 10], /Enter confirm/);
    assert.equal(screen[panelY + 11], "─".repeat(80));
    assert.ok(
      screen
        .slice(0, driver.transcript.viewportHeight)
        .every((line) => line.startsWith("Transcript ")),
    );
    assert.ok(
      screen.slice(panelY).every((line) => !line.includes("Transcript")),
    );
    assert.equal(screen[panelY - 1].trim(), "Widget above");
    assert.equal(screen[panelY + 12].trim(), "Widget below");
    assert.equal(screen.at(-1)?.trim(), "Footer");
    driver.terminal.emit("\x1b");
    assert.equal((await result).cancelled, true);
  } finally {
    driver.stop();
  }
});

test("native fullscreen wheel scrolls upper transcript without losing questionnaire focus or draft", async () => {
  const driver = mount();
  try {
    const { result } = await driver.open();
    driver.transcript.scrollTo(40);
    driver.terminal.emit("\x1b[A"); // custom answer
    driver.terminal.emit("draft");
    const before = driver.screen();
    const panelY = before.findIndex((line) => line.includes("Questionnaire"));
    assert.ok(before.some((line) => line.includes("draft")));
    const panel = driver.component.render(80);
    const cursorY = panel.findIndex((line) => line.includes(CURSOR_MARKER));
    assert.equal(cursorY, panel.length - 3);
    const cursorX = visibleWidth(panel[cursorY].split(CURSOR_MARKER)[0]);
    assert.ok(cursorX >= 0 && cursorX < 80);
    assert.ok(panelY + cursorY < driver.terminal.rows);
    assert.match(before[panelY + cursorY], /draft/);
    assert.ok(before[panelY + panel.length - 2].includes("Ctrl+B/F cursor"));
    assert.equal(before[panelY + panel.length - 1], "─".repeat(80));
    driver.terminal.emit(sgr(64, 80, driver.transcript.viewportHeight));
    assert.equal(driver.transcript.scrollTop, 37); // Host's configured 3 lines.
    driver.terminal.emit(sgr(65));
    assert.equal(driver.transcript.scrollTop, 40);
    driver.terminal.emit(sgr(72)); // native Alt multiplier
    assert.equal(driver.transcript.scrollTop, 25);
    driver.terminal.emit(sgr(81)); // Ctrl wheel, not a cancel key
    assert.equal(driver.transcript.scrollTop, 28);
    assert.equal(driver.host.getFocusedComponent(), driver.component);
    assert.deepEqual(driver.screen().slice(panelY), before.slice(panelY));
    assert.match(driver.screen()[0], /^Transcript 28/);
    driver.terminal.emit("\r");
    driver.host.renderNow();
    driver.terminal.emit("\r");
    const answer = await result;
    assert.equal(answer.cancelled, false);
    assert.equal(answer.answers[0].answer, "draft");
    assert.equal(driver.host.getFocusedComponent(), driver.editor);
    assert.equal(driver.editor.getValue(), "saved editor draft");
    assert.equal(driver.disposals, 1);
    assert.ok(!driver.screen().some((line) => line.includes("[Q1]")));
    assert.equal(driver.transcript.viewportHeight, 16);
    const top = driver.transcript.scrollTop;
    driver.terminal.emit(sgr()); // Still routed by host after custom completion.
    assert.equal(driver.transcript.scrollTop, top - 3);
    driver.terminal.emit("!");
    assert.equal(driver.editor.getValue(), "!saved editor draft");
  } finally {
    driver.stop();
  }
});

test("dock mouse coordinates remain local after resize; short terminals clip without overlap", async () => {
  const driver = mount();
  try {
    const { result } = await driver.open();
    for (const [columns, rows] of [
      [40, 25],
      [15, 12],
      [7, 8],
      [2, 4],
      [1, 2],
      [1, 1],
      [80, 24],
    ]) {
      driver.terminal.resize(columns, rows);
      const screen = driver.screen();
      assert.equal(screen.length, rows);
      assert.ok(screen.every((line) => visibleWidth(line) <= columns));
      assert.equal(
        driver.component.render(columns).length,
        Math.max(1, Math.floor(rows / 2)),
      );
      assert.ok(driver.transcript.viewportHeight >= 1);
      assert.equal(driver.host.getFocusedComponent(), driver.component);
      // At extremely small sizes Pi clips the dock; it never paints over the
      // transcript's reserved row. Keyboard cancellation remains available.
      assert.equal(
        screen[0].trimEnd(),
        driver.document.render(columns)[driver.transcript.scrollTop].trimEnd(),
      );
      const panelY = screen.findIndex((line) => line.includes("Questionnaire"));
      if (panelY >= 0) {
        assert.ok(panelY >= driver.transcript.viewportHeight);
        assert.ok(
          screen.slice(panelY).every((line) => !line.includes("Transcript")),
        );
      }
    }
    driver.terminal.emit("\x1b[D"); // review
    const screen = driver.screen();
    const cancelY = screen.findIndex((line) => line.includes("[ Cancel ]"));
    assert.ok(cancelY > driver.transcript.viewportHeight);
    driver.terminal.emit(sgr(0, 5, cancelY + 1));
    driver.terminal.emit(sgr(0, 5, cancelY + 1, "m"));
    assert.equal((await result).cancelled, true);
    assert.equal(driver.host.getFocusedComponent(), driver.editor);
  } finally {
    driver.stop();
  }
});

test("fullscreen tab clicks target the row below the title after resize", async () => {
  const driver = mount();
  try {
    const { result } = await driver.open();
    for (const rows of [24, 14, 16, 24]) {
      driver.terminal.resize(80, rows);
      const screen = driver.screen();
      const panelY = screen.findIndex((line) => line.includes("Questionnaire"));
      const tabX = screen[panelY + 1].indexOf("[Submit]");
      assert.ok(tabX >= 0);
      // A click at the old row-zero tab position must not change the step.
      driver.terminal.emit(sgr(0, tabX + 1, panelY + 1));
      driver.terminal.emit(sgr(0, tabX + 1, panelY + 1, "m"));
      assert.ok(!driver.screen().some((line) => line.includes("[ Cancel ]")));
      driver.terminal.emit(sgr(0, tabX + 1, panelY + 2));
      driver.terminal.emit(sgr(0, tabX + 1, panelY + 2, "m"));
      const review = driver.screen();
      assert.ok(review.some((line) => line.includes("[ Cancel ]")));
      const questionX = review[panelY + 1].indexOf("[Q1]");
      driver.terminal.emit(sgr(0, questionX + 1, panelY + 2));
      driver.terminal.emit(sgr(0, questionX + 1, panelY + 2, "m"));
      assert.ok(!driver.screen().some((line) => line.includes("[ Cancel ]")));
    }
    driver.terminal.resize(80, 12); // Compact: no navigation row or hit targets.
    const compact = driver.screen();
    const panelY = compact.findIndex((line) => line.includes("Questionnaire"));
    assert.ok(!compact.some((line) => line.includes("[Q1]")));
    driver.terminal.emit(sgr(0, 10, panelY + 2));
    driver.terminal.emit(sgr(0, 10, panelY + 2, "m"));
    assert.ok(!driver.screen().some((line) => line.includes("[ Cancel ]")));
    driver.terminal.emit("\x1b");
    assert.equal((await result).cancelled, true);
  } finally {
    driver.stop();
  }
});

test("abort restores editor and transcript viewport through the host completion contract", async () => {
  const driver = mount();
  const controller = new AbortController();
  try {
    const before = driver.transcript.viewportHeight;
    const { result } = await driver.open(controller.signal);
    const rejected = assert.rejects(result, { name: "AbortError" });
    controller.abort();
    await rejected;
    assert.equal(driver.host.getFocusedComponent(), driver.editor);
    assert.equal(driver.editor.getValue(), "saved editor draft");
    assert.ok(!driver.screen().some((line) => line.includes("[Q1]")));
    assert.equal(driver.transcript.viewportHeight, before);
    assert.equal(driver.disposals, 1);
  } finally {
    driver.stop();
  }
});

test("regular mode keeps keyboard completion and guards raw SGR from custom drafts", async () => {
  const driver = mount(false);
  try {
    const { result } = await driver.open();
    driver.terminal.emit("\x1b[A");
    driver.terminal.emit("draft");
    const before = driver.component.render(80);
    for (const data of [
      sgr(),
      sgr(65),
      sgr(0),
      sgr(0, 1, 1, "m"),
      "\x1b[<bad;1;1M",
    ]) {
      driver.terminal.emit(data);
    }
    assert.deepEqual(driver.component.render(80), before);
    assert.equal(driver.host.getFocusedComponent(), driver.component);
    driver.terminal.emit("\r");
    driver.terminal.emit("\r");
    assert.equal((await result).answers[0].answer, "draft");
    assert.equal(driver.host.getFocusedComponent(), driver.editor);
    assert.equal(driver.editor.getValue(), "saved editor draft");
  } finally {
    driver.stop();
  }
});

test("fullscreen review controls track compact and regular pinned rows after resize", async () => {
  const driver = mount();
  try {
    const { result } = await driver.open();
    driver.terminal.emit("\r"); // confirm A and open review
    for (const rows of [12, 16, 18, 24, 60, 12, 24]) {
      driver.terminal.resize(80, rows);
      const screen = driver.screen();
      const panel = driver.component.render(80);
      const panelY = screen.findIndex((line) => line.includes("Questionnaire"));
      const pinned = panel.length >= 9 ? 4 : 3;
      const submitY = panelY + panel.length - pinned;
      const cancelY = submitY + 1;
      assert.ok(panelY >= driver.transcript.viewportHeight);
      assert.match(screen[submitY], /\[ Submit \]/);
      assert.match(screen[cancelY], /\[ Cancel \]/);
      assert.equal(screen[panelY + panel.length - 1], "─".repeat(80));
      assert.equal(
        panel.some((line) => line.includes("PgUp/PgDn answers")),
        rows >= 18,
      );
      if (rows === 12) {
        assert.ok(panel.some((line) => line.includes("Which approach?")));
        assert.equal(panel[2].trim(), "A");
      }
      // Neither the rule nor a standalone hint may activate a review control.
      for (let y = cancelY + 1; y < panelY + panel.length; y++) {
        driver.terminal.emit(sgr(0, 5, y + 1));
        driver.terminal.emit(sgr(0, 5, y + 1, "m"));
        assert.equal(driver.host.getFocusedComponent(), driver.component);
        assert.equal(driver.disposals, 0);
      }
    }
    const screen = driver.screen();
    const cancelY = screen.findIndex((line) => line.includes("[ Cancel ]"));
    driver.terminal.emit(sgr(0, 5, cancelY + 1));
    driver.terminal.emit(sgr(0, 5, cancelY + 1, "m"));
    const answer = await result;
    assert.equal(answer.cancelled, true);
    assert.equal(answer.answers[0].answer, "A");
    assert.equal(driver.host.getFocusedComponent(), driver.editor);
  } finally {
    driver.stop();
  }
});

for (const status of ["completed", "cancelled", "aborted"] as const) {
  test(`panel closed callback follows host restoration and cleanup (${status})`, async () => {
    const driver = mount();
    const controller = new AbortController();
    const events: string[] = [];
    try {
      const before = driver.transcript.viewportHeight;
      const { result } = await driver.open(controller.signal, {
        onOpen: () => events.push("opened"),
        onClosed: (closed) => {
          events.push(closed);
          assert.equal(driver.host.getFocusedComponent(), driver.editor);
          assert.equal(driver.editor.getValue(), "saved editor draft");
          assert.equal(driver.disposals, 1);
          assert.ok(!driver.screen().some((line) => line.includes("[Q1]")));
          assert.equal(driver.transcript.viewportHeight, before);
        },
      });
      assert.deepEqual(events, ["opened"]);
      if (status === "aborted") {
        const rejected = assert.rejects(result, { name: "AbortError" });
        controller.abort();
        await rejected;
      } else {
        if (status === "completed") {
          driver.terminal.emit("\r");
          driver.terminal.emit("\r");
        } else {
          driver.terminal.emit("\x1b");
        }
        assert.equal((await result).cancelled, status === "cancelled");
      }
      assert.deepEqual(events, ["opened", status]);
    } finally {
      driver.stop();
    }
  });
}
