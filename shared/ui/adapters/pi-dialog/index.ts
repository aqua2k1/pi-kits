import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import {
  type UIEvent,
  type UIField,
  type UINode,
  UIProtocolError,
  type UIView,
} from "../../protocol/index.ts";
import {
  type UIAdapter,
  type UIPort,
  UISessionClosedError,
} from "../../session/index.ts";

export type PiDialogUI = Pick<ExtensionUIContext, "select" | "input">;

type Command =
  | { type: "edit"; field: UIField }
  | { type: "invoke"; nodeId: string }
  | { type: "dismiss" };

const interrupted = new Error("UI dialog interrupted by view update or close.");

/** Display untrusted text without emitting terminal escape/control sequences. */
function plain(value: string, singleLine = false): string {
  const safe = value.replace(
    // biome-ignore lint/suspicious/noControlCharactersInRegex: Escape untrusted terminal controls, preserving LF and TAB.
    /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
  return singleLine ? safe.replace(/[\n\r\u2028\u2029]/g, " ") : safe;
}

function fieldValue(field: UIField): string {
  if (field.type === "text") return field.value;
  const selected = field.type === "single" ? [field.value] : field.value;
  return field.options
    .filter((option) => selected.includes(option.id))
    .map((option) => option.label)
    .join(", ");
}

function menu(view: UIView) {
  const lines: string[] = [];
  const labels: string[] = [];
  const commands: Command[] = [];
  const add = (label: string, command: Command) => {
    labels.push(`${labels.length + 1}. ${plain(label, true)}`);
    commands.push(command);
  };
  const pending: UINode[] = [view.root];
  while (pending.length) {
    const node = pending.pop();
    if (!node) break;
    switch (node.kind) {
      case "group":
        if (node.title) lines.push(plain(node.title));
        if (node.description) lines.push(plain(node.description));
        for (let index = node.children.length - 1; index >= 0; index--) {
          pending.push(node.children[index]);
        }
        break;
      case "content":
        if (node.status) lines.push(`[${node.status}]`);
        lines.push(plain(node.body));
        break;
      case "field":
        lines.push(`${plain(node.label)}: ${plain(fieldValue(node))}`);
        if (node.description) lines.push(plain(node.description));
        if (node.error) lines.push(`Error: ${plain(node.error)}`);
        if (!node.disabled && !node.readOnly) {
          add(`Edit: ${node.label}`, { type: "edit", field: node });
        } else {
          lines.push(node.disabled ? "(disabled)" : "(read-only)");
        }
        break;
      case "action":
        if (!node.disabled) {
          const prefix =
            node.emphasis === "destructive" ? "[destructive] " : "";
          add(`${prefix}${node.label}`, { type: "invoke", nodeId: node.id });
        } else {
          lines.push(`${plain(node.label)} (disabled)`);
        }
        break;
    }
  }
  add("Close", { type: "dismiss" });
  return { title: lines.join("\n") || "UI", labels, commands };
}

async function dialog<T>(
  signal: AbortSignal,
  call: () => Promise<T>,
): Promise<T> {
  signal.throwIfAborted();
  let value: T;
  try {
    value = await call();
  } catch (error) {
    if (
      signal.aborted &&
      (error === signal.reason ||
        (error instanceof Error && error.name === "AbortError"))
    ) {
      throw interrupted;
    }
    throw error;
  }
  if (signal.aborted) throw interrupted;
  return value;
}

async function select(
  ui: PiDialogUI,
  title: string,
  labels: string[],
  signal: AbortSignal,
): Promise<number | undefined> {
  const result = await dialog(signal, () =>
    ui.select(title, labels, { signal }),
  );
  if (result === undefined) return undefined;
  const index = labels.indexOf(result);
  if (index < 0) throw new Error("Pi dialog returned an unknown selection.");
  return index;
}

async function edit(
  ui: PiDialogUI,
  field: UIField,
  signal: AbortSignal,
): Promise<string | null | string[] | undefined> {
  const title = [
    plain(field.label),
    field.description ? plain(field.description) : "",
    `Current value: ${plain(fieldValue(field))}`,
    field.error ? `Error: ${plain(field.error)}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  if (field.type === "text") {
    // Pi's second input argument is a placeholder, NOT an initial value.
    return dialog(signal, () =>
      ui.input(title, plain(field.placeholder ?? ""), { signal }),
    );
  }
  let query = "";
  const matches = (label: string, description = "") =>
    `${label}\n${description}`.toLowerCase().includes(query.toLowerCase());
  const filter = async () => {
    const value = await dialog(signal, () =>
      ui.input("Filter options (empty clears filter)", "", { signal }),
    );
    if (value !== undefined) query = value;
  };
  if (field.type === "single") {
    while (!signal.aborted) {
      const options = field.options.filter(
        (option) =>
          (!option.disabled || option.id === field.value) &&
          matches(option.label, option.description),
      );
      const labels = options.map(
        (option, index) =>
          `${index + 1}. ${plain(option.label, true)}${option.description ? ` — ${plain(option.description, true)}` : ""}`,
      );
      labels.push(`${labels.length + 1}. Clear selection`);
      if (field.filterable) labels.push(`${labels.length + 1}. Filter options`);
      const index = await select(ui, title, labels, signal);
      if (index === undefined) return undefined;
      if (index === options.length + 1) {
        await filter();
        continue;
      }
      return options[index]?.id ?? null;
    }
    throw interrupted;
  }
  let selected = [...field.value];
  while (!signal.aborted) {
    const options = field.options.filter(
      (option) =>
        (!option.disabled || selected.includes(option.id)) &&
        matches(option.label, option.description),
    );
    const labels = options.map(
      (option, index) =>
        `${index + 1}. [${selected.includes(option.id) ? "x" : " "}] ${plain(option.label, true)}${option.description ? ` — ${plain(option.description, true)}` : ""}`,
    );
    labels.push(`${labels.length + 1}. Done`);
    if (field.filterable) labels.push(`${labels.length + 1}. Filter options`);
    const index = await select(ui, title, labels, signal);
    if (index === undefined) return undefined;
    if (index === options.length) return selected;
    if (index === options.length + 1) {
      await filter();
      continue;
    }
    const id = options[index].id;
    selected = selected.includes(id)
      ? selected.filter((value) => value !== id)
      : [...selected, id];
  }
  throw interrupted;
}

async function step(
  ui: PiDialogUI,
  port: UIPort,
  view: UIView,
  signal: AbortSignal,
): Promise<void> {
  const current = menu(view);
  const index = await select(ui, current.title, current.labels, signal);
  const command =
    index === undefined
      ? { type: "dismiss" as const }
      : current.commands[index];
  let event: UIEvent;
  const envelope = { viewId: view.id, revision: view.revision };
  if (command.type === "edit") {
    const value = await edit(ui, command.field, signal);
    if (value === undefined) return; // Cancelling an edit returns to the main menu.
    event = { ...envelope, type: "change", nodeId: command.field.id, value };
  } else if (command.type === "invoke") {
    event = { ...envelope, type: "invoke", nodeId: command.nodeId };
  } else {
    event = { ...envelope, type: "dismiss" };
  }
  signal.throwIfAborted();
  await port.dispatch(event);
}

/** Explicit sequential/plain-text fallback, not a custom TUI or remote renderer. */
export function createPiDialogAdapter(ui: PiDialogUI): UIAdapter {
  let mounted = false;
  return {
    mount(port) {
      if (mounted) throw new Error("Pi dialog adapter is already mounted.");
      if (port.signal.aborted) return { dispose() {} };
      mounted = true;
      let disposed = false;
      let active: AbortController | undefined;
      const interrupt = () => active?.abort(interrupted);
      let unsubscribe: () => void;
      try {
        unsubscribe = port.subscribe(interrupt);
      } catch (error) {
        mounted = false;
        throw error;
      }
      port.signal.addEventListener("abort", interrupt);
      const completion = Promise.resolve().then(async () => {
        try {
          while (!disposed && !port.signal.aborted) {
            const view = port.getSnapshot();
            active = new AbortController();
            try {
              await step(ui, port, view, active.signal);
            } catch (error) {
              if (error === interrupted) continue;
              if (
                error instanceof UISessionClosedError &&
                port.signal.aborted
              ) {
                return;
              }
              if (
                error instanceof UIProtocolError &&
                !port.signal.aborted &&
                port.getSnapshot().revision !== view.revision
              ) {
                continue;
              }
              throw error;
            } finally {
              active = undefined;
            }
          }
        } finally {
          unsubscribe();
          port.signal.removeEventListener("abort", interrupt);
        }
      });
      return {
        completion,
        async dispose() {
          if (disposed) return;
          disposed = true;
          interrupt();
          try {
            await completion;
          } finally {
            mounted = false;
          }
        },
      };
    },
  };
}
