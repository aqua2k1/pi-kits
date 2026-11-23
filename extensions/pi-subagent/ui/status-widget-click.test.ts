import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  ExtensionUIContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component, TuiMouseEvent } from "@earendil-works/pi-tui";
import type { AgentSnapshot } from "../manager.ts";
import { createSubagentStatusWidget } from "./status-widget.ts";

function agent(id: string): AgentSnapshot {
  return {
    id,
    description: `Task ${id}`,
    status: "running",
    supportsView: true,
    terminalId: `terminal-${id}`,
    activity: "read",
  };
}

function harness(onOpen: (id: string) => Promise<void> | void) {
  let agents = [agent("one"), agent("two")];
  let component: Component | undefined;
  const errors: string[] = [];
  const listeners = new Set<() => void>();
  const theme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  } as Theme;
  const ui = {
    setWidget(_key: string, factory: unknown) {
      component =
        typeof factory === "function"
          ? factory({ requestRender() {} }, theme)
          : undefined;
    },
    setStatus() {},
    notify(message: string) {
      errors.push(message);
    },
  } as unknown as ExtensionUIContext;
  const source = {
    list: () => agents,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const widget = createSubagentStatusWidget(
    source,
    { now: () => 2_000, repeat: () => () => {} },
    onOpen,
  );
  widget.bind(ui);
  const renderer = component as unknown as Component;
  return {
    widget,
    renderer,
    errors,
    update(next: AgentSnapshot[]) {
      agents = next;
      for (const listener of listeners) listener();
    },
    mouse(x: number, y: number, type = "click", button = "left") {
      return renderer.handleMouse?.({ x, y, type, button } as TuiMouseEvent);
    },
  };
}

test("widget only opens title rows when supportsView is enabled and terminalId exists", () => {
  const opened: string[] = [];
  const h = harness((id) => {
    opened.push(id);
  });
  h.update([
    agent("one"),
    { ...agent("headless"), supportsView: false },
    { ...agent("q"), status: "queued" },
  ]);
  h.renderer.render(80);
  h.mouse(4, 1);
  h.mouse(4, 3);
  assert.deepEqual(opened, ["one"]);
  h.widget.dispose();
});

test("widget deduplicates pending opens and reports failures without rejecting mouse dispatch", async () => {
  let rejectOpen: (error: Error) => void = () => {};
  let calls = 0;
  const h = harness(() => {
    calls += 1;
    return new Promise<void>((_resolve, reject) => {
      rejectOpen = reject;
    });
  });
  h.renderer.render(80);
  h.mouse(4, 1);
  h.mouse(4, 1);
  assert.equal(calls, 1);
  rejectOpen(new Error("pane unavailable"));
  await new Promise<void>((resolve) => {
    queueMicrotask(resolve);
  });
  assert.deepEqual(h.errors, ["pane unavailable"]);
  h.mouse(4, 1);
  assert.equal(calls, 2);
  h.widget.dispose();
});
