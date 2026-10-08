import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { createPiDialogAdapter } from "@pi-kits/shared/ui/adapters/pi-dialog";
import type {
  UIEvent,
  UIField,
  UINode,
  UIView,
} from "@pi-kits/shared/ui/protocol";
import {
  createUISession,
  type UIAdapter,
  type UISessionOptions,
} from "@pi-kits/shared/ui/session";

type Request = {
  kind: "select" | "input";
  title: string;
  labels: string[];
  placeholder?: string;
  signal: AbortSignal;
  answer(value?: string): void;
  reject(error: unknown): void;
};

// Like Pi, abort resolves undefined. Requests otherwise remain pending until
// explicitly answered: a controller that ignores dismiss cannot spin forever.
function host() {
  const queued: Request[] = [];
  let waiter: ((request: Request) => void) | undefined;
  let delayAbort = false;
  const enqueue = (
    kind: Request["kind"],
    title: string,
    labels: string[],
    placeholder: string | undefined,
    signal: AbortSignal | undefined,
  ) => {
    assert.ok(signal);
    return new Promise<string | undefined>((resolve, reject) => {
      const cleanup = () => signal.removeEventListener("abort", abort);
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
        placeholder,
        signal,
        answer,
        reject(error) {
          cleanup();
          reject(error);
        },
      };
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      if (waiter) {
        const notify = waiter;
        waiter = undefined;
        notify(request);
      } else queued.push(request);
    });
  };
  const ui: Pick<ExtensionUIContext, "select" | "input"> = {
    select: (title, labels, options) =>
      enqueue("select", title, labels, undefined, options?.signal),
    input: (title, placeholder, options) =>
      enqueue("input", title, [], placeholder, options?.signal),
  };
  return {
    ui,
    delayAbort: () => {
      delayAbort = true;
    },
    next: () => {
      const request = queued.shift();
      if (request) return Promise.resolve(request);
      assert.equal(waiter, undefined);
      return new Promise<Request>((resolve) => {
        waiter = resolve;
      });
    },
  };
}

const textField: UIField = {
  kind: "field",
  id: "text",
  label: "Text",
  type: "text",
  value: "current",
  placeholder: "hint",
};
const options = [
  { id: "a", label: "Same" },
  { id: "b", label: "Same" },
  { id: "locked", label: "Locked", disabled: true },
];
function view(root: UINode, revision = 0): UIView {
  return { id: "view", revision, root };
}
function group(...children: UINode[]): UINode {
  return { kind: "group", id: "group", title: "Group", children };
}
function start(
  root: UINode,
  h = host(),
  onEvent?: UISessionOptions["onEvent"],
  adapter: UIAdapter = createPiDialogAdapter(h.ui),
  signal?: AbortSignal,
) {
  const events: UIEvent[] = [];
  const session = createUISession(view(root), {
    adapter,
    signal,
    onEvent(event, current) {
      events.push(event);
      if (onEvent) return onEvent(event, current);
      if (event.type === "dismiss") current.close("dismissed");
    },
  });
  return { h, session, events };
}
async function closeMenu(h: ReturnType<typeof host>) {
  const menu = await h.next();
  menu.answer(menu.labels.at(-1));
}
const config = { timeout: 2000 };

test("content-only closes", config, async () => {
  const { h, session, events } = start({
    kind: "content",
    id: "body",
    format: "markdown",
    body: "Only content",
  });
  const menu = await h.next();
  assert.match(menu.title, /Only content/);
  assert.deepEqual(menu.labels, ["1. Close"]);
  menu.answer(menu.labels[0]);
  assert.deepEqual(await session.closed, { status: "dismissed" });
  assert.deepEqual(events, [{ type: "dismiss", viewId: "view", revision: 0 }]);
});

test("group edits and action IDs", config, async () => {
  const root = group(
    textField,
    { kind: "action", id: "first", label: "Same" },
    { kind: "action", id: "second", label: "Same" },
  );
  const { h, session, events } = start(root, host(), (event, current) => {
    if (event.type === "dismiss") current.close();
    else current.publish(view(root, event.revision + 1));
  });
  let menu = await h.next();
  assert.match(menu.title, /Group/);
  assert.equal(new Set(menu.labels).size, menu.labels.length);
  menu.answer(menu.labels[0]);
  const input = await h.next();
  input.answer("updated");
  menu = await h.next();
  menu.answer(menu.labels[2]);
  await closeMenu(h);
  await session.closed;
  assert.deepEqual(events.slice(0, 2), [
    {
      type: "change",
      viewId: "view",
      revision: 0,
      nodeId: "text",
      value: "updated",
    },
    { type: "invoke", viewId: "view", revision: 1, nodeId: "second" },
  ]);
});

test("text placeholder and empty value", config, async () => {
  for (const placeholder of ["hint", undefined]) {
    const field = { ...textField };
    if (placeholder === undefined) delete field.placeholder;
    else field.placeholder = placeholder;
    const { h, session, events } = start(field);
    const menu = await h.next();
    menu.answer(menu.labels[0]);
    const input = await h.next();
    assert.equal(input.kind, "input");
    assert.equal(input.placeholder, placeholder ?? "");
    assert.match(input.title, /Current value: current/);
    input.answer("");
    await closeMenu(h);
    await session.closed;
    assert.ok(events[0].type === "change");
    assert.equal(events[0].value, "");
  }
});

test("single IDs and clear", config, async () => {
  for (const clear of [false, true]) {
    const { h, session, events } = start({
      kind: "field",
      id: "choice",
      label: "Choice",
      type: "single",
      value: "a",
      options,
    });
    const menu = await h.next();
    menu.answer(menu.labels[0]);
    const choice = await h.next();
    assert.deepEqual(choice.labels, [
      "1. Same",
      "2. Same",
      "3. Clear selection",
    ]);
    choice.answer(choice.labels[clear ? 2 : 1]);
    await closeMenu(h);
    await session.closed;
    assert.ok(events[0].type === "change");
    assert.equal(events[0].value, clear ? null : "b");
  }
});

test("multiple draft and disabled options", config, async () => {
  for (const remove of [false, true]) {
    const { h, session, events } = start({
      kind: "field",
      id: "choice",
      label: "Choice",
      type: "multiple",
      value: ["locked"],
      options,
    });
    const menu = await h.next();
    menu.answer(menu.labels[0]);
    let choice = await h.next();
    choice.answer(choice.labels[1]);
    choice = await h.next();
    assert.equal(events.length, 0);
    assert.match(choice.labels[1], /\[x\] Same/);
    if (remove) {
      choice.answer(choice.labels[2]);
      choice = await h.next();
      assert.ok(choice.labels.every((label) => !label.includes("Locked")));
      assert.equal(events.length, 0);
    }
    choice.answer(choice.labels.at(-1));
    await closeMenu(h);
    await session.closed;
    assert.ok(events[0].type === "change");
    assert.deepEqual(events[0].value, remove ? ["b"] : ["locked", "b"]);
  }
});

test("inner back versus outer dismiss", config, async () => {
  for (const field of [
    textField,
    {
      kind: "field",
      id: "choice",
      label: "Choice",
      type: "multiple",
      value: [],
      options,
    } satisfies UIField,
  ]) {
    const { h, session, events } = start(field);
    let menu = await h.next();
    menu.answer(menu.labels[0]);
    let inner = await h.next();
    if (field.type === "multiple") {
      inner.answer(inner.labels[0]);
      inner = await h.next();
    }
    inner.answer();
    menu = await h.next();
    assert.equal(events.length, 0);
    assert.deepEqual(session.getSnapshot().root, field);
    menu.answer();
    assert.deepEqual(await session.closed, { status: "dismissed" });
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "dismiss");
  }
});

test("disabled/readOnly and escaping", config, async () => {
  const { h, session } = start(
    group(
      { ...textField, id: "disabled", disabled: true, label: "Bad\u001b[31m" },
      { ...textField, id: "readonly", readOnly: true, value: "\u0007bell" },
      {
        kind: "action",
        id: "disabled-action",
        label: "Disabled",
        disabled: true,
      },
      { kind: "action", id: "active", label: "Act\u001b[0m\nnext" },
    ),
  );
  const menu = await h.next();
  assert.equal(menu.labels.length, 2);
  assert.ok(menu.labels.every((label) => !label.includes("Edit:")));
  const rendered = [menu.title, ...menu.labels].join("");
  assert.ok(!rendered.includes("\u001b"));
  assert.ok(!rendered.includes("\u0007"));
  assert.match(menu.title, /\\u001b/);
  assert.match(menu.title, /disabled/);
  assert.match(menu.title, /read-only/);
  assert.ok(menu.labels.every((label) => !label.includes("\n")));
  menu.answer(menu.labels.at(-1));
  await session.closed;
});

test("refresh aborts and ignores late reply", config, async () => {
  const h = host();
  h.delayAbort();
  const { session, events } = start(textField, h);
  let menu = await h.next();
  menu.answer(menu.labels[0]);
  const stale = await h.next();
  session.publish(view({ ...textField, value: "fresh" }, 1));
  assert.equal(stale.signal.aborted, true);
  stale.answer("late mutation");
  menu = await h.next();
  assert.match(menu.title, /fresh/);
  assert.equal(events.length, 0);
  menu.answer();
  await session.closed;
  assert.deepEqual(events, [{ type: "dismiss", viewId: "view", revision: 1 }]);
});

test("external close/abort cleanup", config, async () => {
  for (const input of [false, true]) {
    const controller = new AbortController();
    const { h, session, events } = start(
      textField,
      host(),
      undefined,
      undefined,
      controller.signal,
    );
    let request = await h.next();
    if (input) {
      request.answer(request.labels[0]);
      request = await h.next();
    }
    if (input) controller.abort();
    else session.close();
    assert.deepEqual(await session.closed, {
      status: input ? "aborted" : "completed",
    });
    assert.equal(request.signal.aborted, true);
    assert.equal(events.length, 0);
  }
});

test("host and business failures", config, async () => {
  for (const phase of ["select", "input", "unknown", "business"]) {
    const failure = new Error(phase);
    const { h, session } = start(
      textField,
      host(),
      phase === "business"
        ? () => {
            throw failure;
          }
        : undefined,
    );
    let request = await h.next();
    if (phase === "input" || phase === "business") {
      request.answer(request.labels[0]);
      request = await h.next();
    }
    if (phase === "unknown") request.answer("not a menu label");
    else if (phase === "business") request.answer("new value");
    else request.reject(failure);
    const result = await session.closed;
    assert.equal(result.status, "error");
    if (phase === "unknown")
      assert.match(String(result.error), /unknown selection/);
    else assert.equal(result.error, failure);
  }
});

test("single local filtering and cancel", config, async () => {
  const { h, session, events } = start({
    kind: "field",
    id: "choice",
    label: "Choice",
    type: "single",
    value: null,
    filterable: true,
    options: [
      { id: "a", label: "Alpha" },
      { id: "b", label: "Beta", description: "MATCH here" },
    ],
  });
  const menu = await h.next();
  menu.answer(menu.labels[0]);
  let choice = await h.next();
  assert.match(choice.labels.at(-1) ?? "", /Filter options/);
  choice.answer(choice.labels.at(-1));
  let filter = await h.next();
  assert.equal(filter.kind, "input");
  filter.answer("match");
  choice = await h.next();
  assert.ok(choice.labels.every((label) => !label.includes("Alpha")));
  assert.match(choice.labels[0], /Beta/);
  assert.equal(events.length, 0);
  choice.answer(choice.labels.at(-1));
  filter = await h.next();
  filter.answer();
  choice = await h.next();
  assert.match(choice.labels[0], /Beta/);
  assert.equal(events.length, 0);
  choice.answer(choice.labels.at(-1));
  filter = await h.next();
  filter.answer("");
  choice = await h.next();
  assert.match(choice.labels[0], /Alpha/);
  assert.match(choice.labels[1], /Beta/);
  assert.equal(events.length, 0);
  choice.answer(choice.labels[1]);
  await closeMenu(h);
  await session.closed;
  assert.ok(events[0].type === "change");
  assert.equal(events[0].value, "b");
});

test("single mount and reuse", config, async () => {
  const h = host();
  const adapter = createPiDialogAdapter(h.ui);
  const first = start(textField, h, undefined, adapter);
  const request = await h.next();
  const second = start(textField, h, undefined, adapter);
  const result = await second.session.closed;
  assert.equal(result.status, "error");
  assert.match(String(result.error), /already mounted/);
  first.session.close();
  await first.session.closed;
  assert.equal(request.signal.aborted, true);
  const third = start(textField, h, undefined, adapter);
  await closeMenu(h);
  assert.deepEqual(await third.session.closed, { status: "dismissed" });
});
