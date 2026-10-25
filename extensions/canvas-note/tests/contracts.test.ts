import assert from "node:assert/strict";
import { test } from "node:test";
import {
  Alignment,
  BlockKind,
  blockDefinitions,
  defineHandlers,
  isAlignment,
  isBlockKind,
  MessageKind,
  OperationKind,
  validateBlockContent,
} from "../core/contracts.js";

test("shared enums and definitions are frozen and guards derive from them", () => {
  for (const value of [
    BlockKind,
    Alignment,
    OperationKind,
    MessageKind,
    blockDefinitions,
  ])
    assert.equal(Object.isFrozen(value), true);
  assert.deepEqual(Object.keys(blockDefinitions), Object.values(BlockKind));
  for (const kind of Object.values(BlockKind)) assert.ok(isBlockKind(kind));
  for (const alignment of Object.values(Alignment))
    assert.ok(isAlignment(alignment));
  for (const unknown of [
    null,
    undefined,
    1,
    {},
    "unknown",
    "toString",
    "__proto__",
  ])
    assert.equal(isBlockKind(unknown), false);
  for (const unknown of [null, undefined, 1, {}, "unknown", "toString"])
    assert.equal(isAlignment(unknown), false);
});

test("code content accepts empty and unknown languages and summarizes verbatim", () => {
  assert.equal(BlockKind.Code, "code");
  const code = '<script>alert("只读")</script>\nconst answer = 42;';
  for (const spec of [
    { code: "" },
    { code },
    { code, language: "javascript" },
    { code, language: "" },
    { code, language: "unknown-language", extra: { keep: true } },
  ]) {
    const before = structuredClone(spec);
    Object.freeze(spec);
    validateBlockContent(BlockKind.Code, spec);
    blockDefinitions[BlockKind.Code].validate(spec);
    assert.equal(blockDefinitions[BlockKind.Code].summarize(spec), spec.code);
    assert.deepEqual(spec, before);
  }
  for (const spec of [
    {},
    { code: null },
    { code: 1 },
    { code: false },
    { code: [] },
    { code: {} },
    { code, language: null },
    { code, language: 1 },
    { code, language: false },
    { code, language: [] },
    { code, language: {} },
  ]) {
    const before = structuredClone(spec);
    Object.freeze(spec);
    assert.throws(() => validateBlockContent(BlockKind.Code, spec), /code:/);
    assert.throws(
      () => blockDefinitions[BlockKind.Code].validate(spec),
      /code:/,
    );
    assert.deepEqual(spec, before);
  }
});

test("registries require exactly the enum value keyset at runtime and typecheck", () => {
  const kinds = Object.freeze({ One: "one", Two: "two" });
  const handlers = { one: () => 1, two: () => "two" };
  const registered = defineHandlers(kinds, handlers);
  assert.equal(registered, handlers);
  assert.equal(registered.one(), 1);
  assert.equal(registered.two(), "two");
  assert.ok(Object.isFrozen(registered));
  assert.throws(
    // @ts-expect-error Incomplete registries must fail typecheck too.
    () => defineHandlers(kinds, { one: () => 1 }),
    /Missing handler: two/,
  );
  assert.throws(
    // @ts-expect-error Extra registry keys must fail typecheck too.
    () => defineHandlers(kinds, { ...handlers, extra: () => 3 }),
    /Unexpected handler: extra/,
  );
  const inherited = Object.create({ one: 1, two: 2 });
  assert.throws(() => defineHandlers(kinds, inherited), /Missing handler/);
  assert.throws(
    () =>
      defineHandlers(kinds, {
        ...handlers,
        [Symbol("extra")]: 3,
      } as typeof handlers),
    /Unexpected handler/,
  );
});

test("block validation and summaries preserve inputs and existing validation scope", () => {
  const cases: [
    keyof typeof blockDefinitions,
    Record<string, unknown>,
    string,
  ][] = [
    [BlockKind.Text, { md: "**Text**", extra: { keep: true } }, "**Text**"],
    [BlockKind.Math, { latex: "x^2" }, "x^2"],
    [
      BlockKind.Table,
      { columns: ["A", "B"], rows: [[1], [null, {}]] },
      "A · B",
    ],
    [BlockKind.Chart, { arbitrary: true }, "Chart"],
    [BlockKind.Divider, { arbitrary: true }, "Divider"],
    [BlockKind.Text, { md: "" }, ""],
    [BlockKind.Math, { latex: "" }, ""],
    [BlockKind.Table, { columns: [], rows: [] }, ""],
  ];
  for (const [kind, spec, summary] of cases) {
    const before = structuredClone(spec);
    Object.freeze(spec);
    validateBlockContent(kind, spec);
    blockDefinitions[kind].validate(spec);
    assert.equal(blockDefinitions[kind].summarize(spec), summary);
    assert.deepEqual(spec, before);
  }
  for (const [kind, spec, message] of [
    [BlockKind.Text, {}, "text: spec.md must be a string"],
    [BlockKind.Text, { md: 1 }, "text: spec.md must be a string"],
    [BlockKind.Math, { latex: false }, "math: spec.latex must be a string"],
    [
      BlockKind.Table,
      { columns: [1], rows: [] },
      "table: spec.columns must be strings and spec.rows must be arrays",
    ],
    [
      BlockKind.Table,
      { columns: [], rows: [1] },
      "table: spec.columns must be strings and spec.rows must be arrays",
    ],
  ] as const) {
    const before = structuredClone(spec);
    assert.throws(() => validateBlockContent(kind, spec), { message });
    assert.deepEqual(spec, before);
  }
  for (const type of ["unknown", "toString", "__proto__", undefined, null])
    assert.throws(() => validateBlockContent(type, {}), /Unknown block type:/);
});
