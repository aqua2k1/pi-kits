import type { UIEvent, UIField, UINode, UIView } from "./types.ts";

/** Errors identify protocol structure, never include document or input values. */
export class UIProtocolError extends Error {
  constructor(reason: string) {
    super(`Invalid UI protocol: ${reason}.`);
    this.name = "UIProtocolError";
  }
}

function requireValid(condition: unknown, reason: string): asserts condition {
  if (!condition) throw new UIProtocolError(reason);
}

/** Reject values JSON would drop/coerce, accessors and cyclic object graphs. */
function assertJSON(value: unknown): void {
  const active = new Set<object>();
  const pending: { value: unknown; exit?: boolean }[] = [{ value }];
  while (pending.length) {
    const entry = pending.pop();
    if (!entry) break;
    const current = entry.value;
    if (entry.exit) {
      active.delete(current as object);
      continue;
    }
    if (current === null || typeof current === "string") continue;
    if (typeof current === "boolean") continue;
    if (typeof current === "number") {
      requireValid(Number.isFinite(current), "non-finite number");
      continue;
    }
    requireValid(typeof current === "object", "non-JSON value");
    requireValid(!active.has(current), "cyclic data");
    const array = Array.isArray(current);
    requireValid(
      Object.getPrototypeOf(current) ===
        (array ? Array.prototype : Object.prototype),
      "non-plain object",
    );
    const descriptors = Object.getOwnPropertyDescriptors(current);
    requireValid(
      Object.getOwnPropertySymbols(current).length === 0,
      "symbol key",
    );
    if (array) {
      requireValid(
        Object.keys(descriptors).length === current.length + 1,
        "sparse or extended array",
      );
    }
    active.add(current);
    pending.push({ value: current, exit: true });
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (array && key === "length") continue;
      requireValid(
        "value" in descriptor && descriptor.enumerable,
        "accessor or non-enumerable property",
      );
      if (array) {
        const index = Number(key);
        requireValid(
          Number.isInteger(index) &&
            index >= 0 &&
            index < current.length &&
            String(index) === key,
          "invalid array key",
        );
      }
      pending.push({ value: descriptor.value });
    }
  }
}

function object(value: unknown): Record<string, unknown> {
  requireValid(
    value !== null && typeof value === "object" && !Array.isArray(value),
    "expected object",
  );
  return value as Record<string, unknown>;
}

function keys(value: Record<string, unknown>, allowed: string[]): void {
  requireValid(
    Object.keys(value).every((key) => allowed.includes(key)),
    "unknown property",
  );
}

function string(value: unknown): asserts value is string {
  requireValid(typeof value === "string", "expected string");
}

function id(value: unknown): asserts value is string {
  string(value);
  requireValid(value.trim().length > 0, "empty identifier");
}

function revision(value: unknown): void {
  requireValid(
    Number.isSafeInteger(value) && (value as number) >= 0,
    "invalid revision",
  );
}

function optionalStrings(
  value: Record<string, unknown>,
  names: string[],
): void {
  for (const name of names) if (name in value) string(value[name]);
}

function optionalBooleans(
  value: Record<string, unknown>,
  names: string[],
): void {
  for (const name of names) {
    if (name in value)
      requireValid(typeof value[name] === "boolean", "expected boolean");
  }
}

function strings(value: unknown): asserts value is string[] {
  requireValid(Array.isArray(value), "expected array");
  for (const item of value) string(item);
  requireValid(new Set(value).size === value.length, "duplicate selection");
}

function validateField(node: Record<string, unknown>): void {
  const base = [
    "kind",
    "id",
    "label",
    "description",
    "disabled",
    "readOnly",
    "error",
    "type",
    "value",
  ];
  string(node.label);
  optionalStrings(node, ["description", "error"]);
  optionalBooleans(node, ["disabled", "readOnly"]);
  if (node.type === "text") {
    keys(node, [...base, "placeholder"]);
    string(node.value);
    optionalStrings(node, ["placeholder"]);
    return;
  }
  requireValid(
    node.type === "single" || node.type === "multiple",
    "unknown field type",
  );
  keys(node, [...base, "options", "filterable"]);
  optionalBooleans(node, ["filterable"]);
  requireValid(Array.isArray(node.options), "expected options");
  const optionIds = new Set<string>();
  for (const value of node.options) {
    const option = object(value);
    keys(option, ["id", "label", "description", "disabled"]);
    id(option.id);
    string(option.label);
    optionalStrings(option, ["description"]);
    optionalBooleans(option, ["disabled"]);
    requireValid(!optionIds.has(option.id), "duplicate option identifier");
    optionIds.add(option.id);
  }
  if (node.type === "single") {
    requireValid(
      node.value === null || typeof node.value === "string",
      "invalid single value",
    );
    requireValid(
      node.value === null || optionIds.has(node.value),
      "unknown selected option",
    );
  } else {
    strings(node.value);
    requireValid(
      node.value.every((value) => optionIds.has(value)),
      "unknown selected option",
    );
  }
}

function validateView(value: unknown): Map<string, UINode> {
  assertJSON(value);
  const view = object(value);
  keys(view, ["id", "revision", "root"]);
  id(view.id);
  revision(view.revision);
  const nodes = new Map<string, UINode>();
  const pending = [view.root];
  while (pending.length) {
    const node = object(pending.pop());
    id(node.id);
    requireValid(!nodes.has(node.id), "duplicate node identifier");
    switch (node.kind) {
      case "group":
        keys(node, ["kind", "id", "title", "description", "children"]);
        optionalStrings(node, ["title", "description"]);
        requireValid(Array.isArray(node.children), "expected children");
        for (const child of node.children) pending.push(child);
        break;
      case "content":
        keys(node, ["kind", "id", "format", "body", "summary", "status"]);
        requireValid(
          ["text", "markdown", "json"].includes(node.format as string),
          "unknown content format",
        );
        string(node.body);
        optionalStrings(node, ["summary"]);
        if ("status" in node) {
          requireValid(
            [
              "info",
              "running",
              "success",
              "warning",
              "error",
              "cancelled",
              "stale",
              "truncated",
            ].includes(node.status as string),
            "unknown content status",
          );
        }
        break;
      case "field":
        validateField(node);
        break;
      case "action":
        keys(node, ["kind", "id", "label", "disabled", "emphasis"]);
        string(node.label);
        optionalBooleans(node, ["disabled"]);
        if ("emphasis" in node) {
          requireValid(
            ["default", "primary", "destructive"].includes(
              node.emphasis as string,
            ),
            "unknown action emphasis",
          );
        }
        break;
      default:
        throw new UIProtocolError("unknown node kind");
    }
    nodes.set(node.id, node as unknown as UINode);
  }
  return nodes;
}

export function assertUIView(value: unknown): asserts value is UIView {
  validateView(value);
}

export function assertUIEvent(value: unknown): asserts value is UIEvent {
  assertJSON(value);
  const event = object(value);
  id(event.viewId);
  revision(event.revision);
  if (event.type === "dismiss") {
    keys(event, ["type", "viewId", "revision"]);
    return;
  }
  id(event.nodeId);
  if (event.type === "invoke") {
    keys(event, ["type", "viewId", "revision", "nodeId"]);
    return;
  }
  requireValid(event.type === "change", "unknown event type");
  keys(event, ["type", "viewId", "revision", "nodeId", "value"]);
  if (Array.isArray(event.value)) strings(event.value);
  else
    requireValid(
      event.value === null || typeof event.value === "string",
      "invalid change value",
    );
}

function validateChange(
  field: UIField,
  event: Extract<UIEvent, { type: "change" }>,
): void {
  requireValid(!field.disabled && !field.readOnly, "field is not editable");
  if (field.type === "text") {
    string(event.value);
    return;
  }
  const previous = field.type === "single" ? [field.value] : field.value;
  let selected: string[];
  if (field.type === "single") {
    requireValid(
      event.value === null || typeof event.value === "string",
      "invalid single value",
    );
    selected = event.value === null ? [] : [event.value];
  } else {
    strings(event.value);
    selected = event.value;
  }
  for (const optionId of selected) {
    const option = field.options.find((item) => item.id === optionId);
    requireValid(option, "unknown selected option");
    requireValid(
      !option.disabled || previous.includes(optionId),
      "option is disabled",
    );
  }
}

/** Structural/state checks only; business authorization remains the caller's job. */
export function assertUIEventForView(
  view: UIView,
  event: unknown,
): asserts event is UIEvent {
  const nodes = validateView(view);
  assertUIEvent(event);
  requireValid(
    event.viewId === view.id && event.revision === view.revision,
    "stale or mismatched view",
  );
  if (event.type === "dismiss") return;
  const node = nodes.get(event.nodeId);
  requireValid(node, "unknown target node");
  if (event.type === "invoke") {
    requireValid(node.kind === "action", "target is not an action");
    requireValid(!node.disabled, "action is disabled");
  } else {
    requireValid(node.kind === "field", "target is not a field");
    validateChange(node, event);
  }
}
