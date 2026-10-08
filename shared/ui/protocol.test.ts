import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  assertUIEvent,
  assertUIEventForView,
  assertUIView,
  type UIEvent,
  type UINode,
  UIProtocolError,
  type UIView,
} from "@pi-kits/shared/ui/protocol";
import ts from "typescript";

const options = [
  { id: "a", label: "Same label", description: "First" },
  { id: "b", label: "Same label", disabled: false },
  { id: "locked", label: "Unavailable", disabled: true },
];

function textField(): UINode {
  return {
    kind: "field",
    id: "text",
    type: "text",
    label: "Text",
    description: "Description",
    value: "",
    placeholder: "Write here",
    disabled: false,
    readOnly: false,
    error: "",
  };
}

function singleField(): UINode {
  return {
    kind: "field",
    id: "single",
    type: "single",
    label: "Choose one",
    value: null,
    options: structuredClone(options),
    filterable: true,
  };
}

function multipleField(): UINode {
  return {
    kind: "field",
    id: "multiple",
    type: "multiple",
    label: "Choose many",
    value: [],
    options: structuredClone(options),
    filterable: false,
  };
}

function view(root?: UINode): UIView {
  return {
    id: "view-日志",
    revision: 7,
    root: root ?? {
      kind: "group",
      id: "root",
      title: "Title",
      description: "Description",
      children: [
        { kind: "content", id: "content", format: "text", body: "Body" },
        {
          kind: "group",
          id: "nested",
          children: [textField(), singleField(), multipleField()],
        },
        {
          kind: "action",
          id: "submit",
          label: "Submit",
          disabled: false,
          emphasis: "primary",
        },
      ],
    },
  };
}

function change(nodeId: string, value: string | null | string[]): UIEvent {
  return { type: "change", viewId: "view-日志", revision: 7, nodeId, value };
}

function invoke(nodeId = "submit"): UIEvent {
  return { type: "invoke", viewId: "view-日志", revision: 7, nodeId };
}

function dismiss(): UIEvent {
  return { type: "dismiss", viewId: "view-日志", revision: 7 };
}

function rejectsView(value: unknown, label: string): void {
  assert.throws(() => assertUIView(value), UIProtocolError, label);
}

function rejectsEvent(value: unknown, label: string): void {
  assert.throws(() => assertUIEvent(value), UIProtocolError, label);
}

function rejectsForView(current: UIView, event: unknown, label: string): void {
  assert.throws(
    () => assertUIEventForView(current, event),
    UIProtocolError,
    label,
  );
}

function roundtrip<T>(value: T): unknown {
  return JSON.parse(JSON.stringify(value));
}

test("public protocol exports validate JSON roundtrips and narrow unknown values", () => {
  const original = view();
  const decoded: unknown = roundtrip(original);
  assertUIView(decoded);
  const typedView: UIView = decoded;
  const typedRoot: UINode = typedView.root;
  assert.deepEqual(typedView, original);
  assert.equal(typedRoot.kind, "group");
  for (const originalEvent of [
    change("text", "日志🙂"),
    change("single", null),
    change("single", "a"),
    change("multiple", ["a", "b"]),
    invoke(),
    dismiss(),
  ]) {
    const decodedEvent: unknown = roundtrip(originalEvent);
    assertUIEvent(decodedEvent);
    const typedEvent: UIEvent = decodedEvent;
    assert.deepEqual(typedEvent, originalEvent);
    assertUIEventForView(typedView, decodedEvent);
  }
  assert.ok(new UIProtocolError("Invalid protocol") instanceof Error);
});

test("all content formats, statuses and action emphases are serializable", () => {
  for (const format of ["text", "markdown", "json"] as const) {
    for (const status of [
      "info",
      "running",
      "success",
      "warning",
      "error",
      "cancelled",
      "stale",
      "truncated",
    ] as const) {
      const current = view({
        kind: "content",
        id: "document",
        format,
        body: "not necessarily parsed JSON",
        summary: "",
        status,
      });
      assertUIView(roundtrip(current));
    }
  }
  for (const emphasis of ["default", "primary", "destructive"] as const) {
    assertUIView(view({ kind: "action", id: "action", label: "", emphasis }));
  }
  for (const revision of [0, Number.MAX_SAFE_INTEGER]) {
    assertUIView({ ...view(), revision });
    assertUIEvent({ ...dismiss(), revision });
  }
});

test("empty business values and duplicate option labels are legal", () => {
  for (const root of [
    textField(),
    singleField(),
    multipleField(),
    {
      kind: "group",
      id: "empty",
      title: "",
      description: "",
      children: [],
    } as UINode,
    {
      kind: "content",
      id: "empty",
      format: "text",
      body: "",
      summary: "",
    } as UINode,
  ]) {
    assertUIView(view(root));
  }
  const emptyValues: [UINode, string | null | string[]][] = [
    [textField(), ""],
    [singleField(), null],
    [multipleField(), []],
  ];
  for (const [field, value] of emptyValues) {
    assertUIEventForView(view(field), change(field.id, value));
  }
  for (const field of [singleField(), multipleField()]) {
    assertUIView(view({ ...field, label: "", options: [] } as UINode));
  }
});

test("views reject malformed envelopes, identifiers and revisions", () => {
  for (const invalid of [
    null,
    undefined,
    true,
    1,
    "view",
    [],
    {},
    new Date(),
    new Map(),
  ]) {
    rejectsView(invalid, "invalid view object");
  }
  for (const id of ["", " \t\n", null, 1, undefined]) {
    rejectsView({ ...view(), id }, "view ID");
    rejectsView({ ...view(), root: { ...textField(), id } }, "node ID");
  }
  for (const revision of [
    -1,
    0.5,
    NaN,
    Infinity,
    -Infinity,
    Number.MAX_SAFE_INTEGER + 1,
    "7",
    null,
    undefined,
  ]) {
    rejectsView({ ...view(), revision }, "view revision");
    rejectsEvent({ ...dismiss(), revision }, "event revision");
  }
  rejectsView({ ...view(), extra: true }, "unknown view property");
  for (const key of ["id", "revision", "root"]) {
    const invalid: Record<string, unknown> = { ...view() };
    delete invalid[key];
    rejectsView(invalid, `missing ${key}`);
  }
});

test("node variants reject unknown fields, missing fields and wrong types", () => {
  const roots: UINode[] = [
    { kind: "group", id: "group", children: [] },
    { kind: "content", id: "content", format: "markdown", body: "" },
    textField(),
    singleField(),
    multipleField(),
    { kind: "action", id: "action", label: "Action" },
  ];
  for (const root of roots) {
    rejectsView(
      { ...view(), root: { ...root, extra: true } },
      `${root.kind} unknown property`,
    );
    for (const key of ["kind", "id"]) {
      const invalid: Record<string, unknown> = { ...root };
      delete invalid[key];
      rejectsView({ ...view(), root: invalid }, `missing node ${key}`);
    }
  }
  const invalidRoots: unknown[] = [
    null,
    [],
    "node",
    new Date(),
    { kind: "collection", id: "later", children: [] },
    { kind: "group", id: "g" },
    { kind: "group", id: "g", children: {} },
    { kind: "group", id: "g", children: [], title: 1 },
    { kind: "content", id: "c", format: "html", body: "" },
    { kind: "content", id: "c", format: "text" },
    { kind: "content", id: "c", format: "text", body: 1 },
    { kind: "content", id: "c", format: "text", body: "", status: "done" },
    { ...textField(), label: null },
    { ...textField(), description: 1 },
    { ...textField(), disabled: "false" },
    { ...textField(), readOnly: 0 },
    { ...textField(), error: false },
    { ...textField(), placeholder: 1 },
    { ...textField(), type: "select" },
    { ...textField(), value: null },
    { ...textField(), value: [] },
    { ...textField(), options: [] },
    { ...singleField(), value: [] },
    { ...singleField(), options: null },
    { ...singleField(), filterable: "yes" },
    { ...singleField(), placeholder: "not supported" },
    { ...multipleField(), value: "a" },
    { ...multipleField(), value: null },
    { kind: "action", id: "a" },
    { kind: "action", id: "a", label: 1 },
    { kind: "action", id: "a", label: "", disabled: 1 },
    { kind: "action", id: "a", label: "", emphasis: "warning" },
  ];
  for (const root of invalidRoots)
    rejectsView({ ...view(), root }, "invalid node variant");
});

test("optional keys explicitly set to undefined are rejected at every level", () => {
  const specimens: [UINode, string[]][] = [
    [{ kind: "group", id: "g", children: [] }, ["title", "description"]],
    [
      { kind: "content", id: "c", format: "text", body: "" },
      ["summary", "status"],
    ],
    [
      textField(),
      ["description", "disabled", "readOnly", "error", "placeholder"],
    ],
    [
      singleField(),
      ["description", "disabled", "readOnly", "error", "filterable"],
    ],
    [
      multipleField(),
      ["description", "disabled", "readOnly", "error", "filterable"],
    ],
    [{ kind: "action", id: "a", label: "" }, ["disabled", "emphasis"]],
  ];
  for (const [root, keys] of specimens) {
    for (const key of keys) {
      rejectsView(
        { ...view(), root: { ...root, [key]: undefined } },
        `${root.kind}.${key}`,
      );
    }
  }
  for (const key of ["description", "disabled"]) {
    rejectsView(
      view({
        ...singleField(),
        options: [{ id: "a", label: "", [key]: undefined }],
      } as UINode),
      `option.${key}`,
    );
  }
  rejectsView({ ...view(), extra: undefined }, "unknown undefined property");
  rejectsEvent(
    { ...dismiss(), nodeId: undefined },
    "dismiss must not contain nodeId",
  );
});

test("node IDs are globally unique but option IDs are local to each field", () => {
  assertUIView(view()); // The two selection fields intentionally reuse option IDs.
  const duplicateTrees: UINode[] = [
    { kind: "group", id: "text", children: [textField()] },
    { kind: "group", id: "g", children: [textField(), textField()] },
    {
      kind: "group",
      id: "g",
      children: [
        textField(),
        { kind: "group", id: "other", children: [textField()] },
      ],
    },
  ];
  for (const root of duplicateTrees)
    rejectsView(view(root), "duplicate node IDs");
  for (const field of [singleField(), multipleField()]) {
    rejectsView(
      view({ ...field, options: [options[0], options[0]] } as UINode),
      "duplicate option IDs",
    );
    for (const option of [
      null,
      [],
      { id: "a" },
      { id: "", label: "" },
      { id: " \n", label: "" },
      { id: 1, label: "" },
      { id: "a", label: 1 },
      { id: "a", label: "", description: false },
      { id: "a", label: "", disabled: 1 },
      { id: "a", label: "", extra: true },
    ]) {
      rejectsView(
        { ...view(), root: { ...field, options: [option] } },
        "invalid option",
      );
    }
  }
  rejectsView(
    view({ ...singleField(), value: "missing" } as UINode),
    "unknown single value",
  );
  for (const value of [["missing"], ["a", "a"], [1], [null]]) {
    rejectsView(
      { ...view(), root: { ...multipleField(), value } },
      "invalid multiple value",
    );
  }
});

test("validators reject non-JSON objects, symbols, getters and sparse arrays without reading getters", () => {
  class ViewLike {
    id = "view-日志";
    revision = 7;
    root = textField();
  }
  rejectsView(new ViewLike(), "class instance");
  rejectsView(Object.create(view()), "inherited view properties");
  rejectsView(
    { ...view(), root: Object.create(textField()) },
    "inherited node properties",
  );
  rejectsEvent(Object.create(dismiss()), "inherited event properties");
  rejectsView({ ...view(), [Symbol("secret")]: "secret" }, "symbol view key");
  rejectsView(
    { ...view(), root: { ...textField(), [Symbol("secret")]: true } },
    "symbol node key",
  );
  rejectsEvent({ ...dismiss(), [Symbol("secret")]: true }, "symbol event key");
  rejectsEvent(
    change("text", Symbol("value") as unknown as string),
    "symbol value",
  );

  let reads = 0;
  const accessor = (base: object, key: string): object =>
    Object.defineProperty(base, key, {
      enumerable: true,
      get() {
        reads++;
        throw new Error("Getter must not run");
      },
    });
  rejectsView(accessor({ ...view() }, "root"), "view getter");
  rejectsView(
    { ...view(), root: accessor({ ...textField() }, "value") },
    "field getter",
  );
  rejectsView(
    {
      ...view(),
      root: {
        ...singleField(),
        options: [accessor({ ...options[0] }, "label")],
      },
    },
    "option getter",
  );
  rejectsEvent(accessor({ ...change("text", "") }, "value"), "event getter");
  const getterChildren = accessor([textField()], "0");
  rejectsView(
    { ...view(), root: { kind: "group", id: "g", children: getterChildren } },
    "array getter",
  );
  assert.equal(reads, 0);

  const sparse = new Array(2);
  sparse[1] = "a";
  rejectsView(
    { ...view(), root: { kind: "group", id: "g", children: new Array(1) } },
    "sparse children",
  );
  rejectsView(
    { ...view(), root: { ...singleField(), options: new Array(1) } },
    "sparse options",
  );
  rejectsView(
    { ...view(), root: { ...multipleField(), value: sparse } },
    "sparse field value",
  );
  rejectsEvent(change("multiple", sparse), "sparse event value");
  for (const value of [
    Object.assign(["a"], { extra: true }),
    Object.assign(["a"], { [Symbol("extra")]: true }),
  ]) {
    rejectsEvent(change("multiple", value), "non-JSON array properties");
  }
});

test("events enforce the closed envelope and discriminated value shape", () => {
  for (const invalid of [null, undefined, [], {}, new Date(), true, "event"])
    rejectsEvent(invalid, "invalid event object");
  for (const event of [change("text", ""), invoke(), dismiss()]) {
    for (const key of ["type", "viewId", "revision"]) {
      const invalid: Record<string, unknown> = { ...event };
      delete invalid[key];
      rejectsEvent(invalid, `missing event ${key}`);
    }
    rejectsEvent({ ...event, extra: true }, "unknown event property");
    for (const viewId of ["", " \n", 1, null, undefined])
      rejectsEvent({ ...event, viewId }, "invalid viewId");
  }
  for (const nodeId of ["", " \t", 1, null, undefined]) {
    rejectsEvent({ ...invoke(), nodeId }, "invalid invoke target");
    rejectsEvent({ ...change("text", ""), nodeId }, "invalid change target");
  }
  for (const value of [
    undefined,
    1,
    NaN,
    Infinity,
    true,
    {},
    [1],
    [null],
    ["a", undefined],
  ]) {
    rejectsEvent({ ...change("text", ""), value }, "invalid change value");
  }
  const missingValue: Record<string, unknown> = { ...change("text", "") };
  delete missingValue.value;
  rejectsEvent(missingValue, "missing change value");
  rejectsEvent({ ...invoke(), value: "" }, "invoke cannot carry value");
  rejectsEvent({ ...dismiss(), nodeId: "text" }, "dismiss cannot carry target");
  rejectsEvent({ ...dismiss(), value: null }, "dismiss cannot carry value");
  rejectsEvent(
    { ...invoke(), type: "select", itemId: "a" },
    "select is not implemented",
  );
  for (const value of ["", null, [], ["a", "b"]])
    assertUIEvent(change("arbitrary", value));
});

test("view-aware validation rejects stale events, missing or wrong targets and invalid views", () => {
  const current = view();
  for (const event of [change("text", ""), invoke(), dismiss()]) {
    rejectsForView(current, { ...event, viewId: "another" }, "wrong view");
    rejectsForView(current, { ...event, revision: 6 }, "older revision");
    rejectsForView(current, { ...event, revision: 8 }, "future revision");
  }
  rejectsForView(
    current,
    { ...dismiss(), extra: true },
    "event must be validated",
  );
  rejectsForView(
    { ...current, revision: -1 },
    dismiss(),
    "view must be validated even for dismiss",
  );
  rejectsForView(
    view({ ...singleField(), value: "missing" } as UINode),
    dismiss(),
    "invalid view tree",
  );
  rejectsForView(current, invoke("missing"), "unknown action");
  rejectsForView(current, change("missing", ""), "unknown field");
  for (const id of [
    "root",
    "nested",
    "content",
    "text",
    "single",
    "multiple",
  ]) {
    rejectsForView(current, invoke(id), "invoke requires action");
  }
  for (const id of ["root", "nested", "content", "submit"]) {
    rejectsForView(current, change(id, ""), "change requires field");
  }
  assertUIEventForView(current, invoke());
  assertUIEventForView(current, dismiss());
});

test("disabled actions and disabled or read-only fields cannot be edited", () => {
  rejectsForView(
    view({ kind: "action", id: "submit", label: "", disabled: true }),
    invoke(),
    "disabled action",
  );
  for (const field of [textField(), singleField(), multipleField()]) {
    const value = field.kind === "field" ? field.value : "";
    for (const key of ["disabled", "readOnly"]) {
      rejectsForView(
        view({ ...field, [key]: true }),
        change(field.id, value),
        key,
      );
      assertUIEventForView(
        view({ ...field, [key]: false }),
        change(field.id, value),
      );
    }
  }
});

test("view-aware changes enforce field types and option identity", () => {
  const invalid: [UINode, unknown[]][] = [
    [textField(), [null, [], ["a"]]],
    [singleField(), [[], ["a"], "missing"]],
    [multipleField(), [null, "a", ["missing"], ["a", "a"]]],
  ];
  for (const [field, values] of invalid) {
    for (const value of values)
      rejectsForView(
        view(field),
        { ...change(field.id, ""), value },
        "field-specific value",
      );
  }
  assertUIEventForView(view(singleField()), change("single", "b"));
  assertUIEventForView(view(multipleField()), change("multiple", ["b", "a"]));
});

test("disabled options may be retained or removed but never newly selected", () => {
  rejectsForView(
    view(singleField()),
    change("single", "locked"),
    "new disabled single option",
  );
  const selectedSingle = view({ ...singleField(), value: "locked" } as UINode);
  assertUIView(selectedSingle);
  for (const value of ["locked", null, "a"])
    assertUIEventForView(selectedSingle, change("single", value));
  rejectsForView(
    view(multipleField()),
    change("multiple", ["locked"]),
    "new disabled multiple option",
  );
  const selectedMultiple = view({
    ...multipleField(),
    value: ["locked", "a"],
  } as UINode);
  assertUIView(selectedMultiple);
  for (const value of [
    ["locked", "a"],
    ["a", "locked", "b"],
    ["locked"],
    ["a"],
    [],
  ]) {
    assertUIEventForView(selectedMultiple, change("multiple", value));
  }
  const secondDisabled = view({
    ...multipleField(),
    value: ["locked"],
    options: [
      ...options,
      { id: "also-locked", label: "Unavailable", disabled: true },
    ],
  } as UINode);
  rejectsForView(
    secondDisabled,
    change("multiple", ["locked", "also-locked"]),
    "only existing disabled selections are allowed",
  );
});

test("protocol errors do not leak document bodies or rejected values", () => {
  const secret = "PRIVATE_PAYLOAD_7b93f0";
  const failures = [
    () =>
      assertUIView({
        ...view(),
        root: { kind: "content", id: "c", format: "invalid", body: secret },
      }),
    () => assertUIView(view({ ...singleField(), value: secret } as UINode)),
    () =>
      assertUIView({ ...view(), root: { ...textField(), value: { secret } } }),
    () => assertUIEvent({ ...change("text", ""), value: { secret } }),
    () => assertUIEventForView(view(singleField()), change("single", secret)),
    () =>
      assertUIEventForView(view(multipleField()), change("multiple", [secret])),
  ];
  for (const fail of failures) {
    assert.throws(fail, (error: unknown) => {
      assert.ok(error instanceof UIProtocolError);
      assert.ok(!error.message.includes(secret));
      assert.ok(!String(error).includes(secret));
      assert.ok(!JSON.stringify(error).includes(secret));
      return true;
    });
  }
});

test("public protocol import has a pure relative-only runtime dependency graph", () => {
  // Inspect the actual public entry and its dependency closure without loading Pi.
  const entry = import.meta.resolve("@pi-kits/shared/ui/protocol");
  const visited = new Set<string>();
  function inspect(url: string): void {
    if (visited.has(url)) return;
    visited.add(url);
    const filename = fileURLToPath(url);
    const source = ts.createSourceFile(
      filename,
      readFileSync(filename, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    function dependency(specifier: string): void {
      assert.ok(
        specifier.startsWith("./") || specifier.startsWith("../"),
        `protocol runtime dependency must be relative: ${specifier}`,
      );
      inspect(new URL(specifier, url).href);
    }
    function walk(node: ts.Node): void {
      if (ts.isImportDeclaration(node)) {
        const clause = node.importClause;
        const bindings = clause?.namedBindings;
        const typeOnly =
          clause?.isTypeOnly ||
          (bindings &&
            ts.isNamedImports(bindings) &&
            bindings.elements.length > 0 &&
            bindings.elements.every((element) => element.isTypeOnly) &&
            !clause?.name);
        if (!typeOnly) {
          assert.ok(ts.isStringLiteral(node.moduleSpecifier));
          dependency(node.moduleSpecifier.text);
        }
      } else if (
        ts.isExportDeclaration(node) &&
        node.moduleSpecifier &&
        !node.isTypeOnly
      ) {
        const typeOnly =
          node.exportClause &&
          ts.isNamedExports(node.exportClause) &&
          node.exportClause.elements.length > 0 &&
          node.exportClause.elements.every((element) => element.isTypeOnly);
        if (!typeOnly) {
          assert.ok(ts.isStringLiteral(node.moduleSpecifier));
          dependency(node.moduleSpecifier.text);
        }
      } else if (ts.isImportEqualsDeclaration(node) && !node.isTypeOnly) {
        assert.fail("protocol must not use runtime import-equals");
      } else if (ts.isCallExpression(node)) {
        assert.notEqual(
          node.expression.kind,
          ts.SyntaxKind.ImportKeyword,
          "protocol must not dynamically import runtime dependencies",
        );
        if (ts.isIdentifier(node.expression)) {
          assert.ok(
            !["require", "eval", "Function"].includes(node.expression.text),
            "protocol must not indirectly load runtime dependencies",
          );
        }
      }
      ts.forEachChild(node, walk);
    }
    walk(source);
  }
  inspect(entry);
  assert.ok(visited.size > 0);
});
