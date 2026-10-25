// @ts-check

export const BlockKind = Object.freeze({
  Text: "text",
  Code: "code",
  Chart: "chart",
  Math: "math",
  Table: "table",
  Divider: "divider",
});
export const Alignment = Object.freeze({
  Left: "left",
  Center: "center",
  Right: "right",
});
export const OperationKind = Object.freeze({
  CreatePage: "page:create",
  InsertBlocks: "blocks:insert",
  UpdateBlocks: "blocks:update",
});
export const MessageKind = Object.freeze({
  Reply: "reply",
  Ack: "ack",
  Error: "error",
  Shutdown: "shutdown",
  ServerClosing: "server:closing",
  Snapshot: "snapshot",
  Operations: "operations",
  Resync: "resync",
  RenderError: "render:error",
});

/**
 * Register exactly one handler for every enum value.
 * @template {Record<string, string>} K
 * @template {Record<K[keyof K], unknown>} H
 * @param {K} kinds
 * @param {H & Record<Exclude<keyof H, K[keyof K]>, never>} handlers
 * @returns {Readonly<H>}
 */
export function defineHandlers(kinds, handlers) {
  const expected = new Set(Object.values(kinds));
  for (const kind of expected) {
    if (!Object.hasOwn(handlers, kind))
      throw new Error(`Missing handler: ${kind}`);
  }
  for (const key of Reflect.ownKeys(handlers)) {
    if (typeof key !== "string" || !expected.has(key))
      throw new Error(`Unexpected handler: ${String(key)}`);
  }
  return Object.freeze(handlers);
}

/**
 * @typedef {Record<string, unknown>} BlockSpec
 * @typedef {{validate(spec: BlockSpec): void, summarize(spec: BlockSpec): string}} BlockDefinition
 */

/** @satisfies {Record<(typeof BlockKind)[keyof typeof BlockKind], BlockDefinition>} */
const definitions = {
  [BlockKind.Text]: {
    validate(spec) {
      if (typeof spec.md !== "string")
        throw new Error("text: spec.md must be a string");
    },
    summarize: (spec) => /** @type {string} */ (spec.md),
  },
  [BlockKind.Code]: {
    validate(spec) {
      if (typeof spec.code !== "string")
        throw new Error("code: spec.code must be a string");
      if (spec.language !== undefined && typeof spec.language !== "string")
        throw new Error("code: spec.language must be a string");
    },
    summarize: (spec) => /** @type {string} */ (spec.code),
  },
  [BlockKind.Chart]: {
    validate(_spec) {},
    summarize: (_spec) => "Chart",
  },
  [BlockKind.Math]: {
    validate(spec) {
      if (typeof spec.latex !== "string")
        throw new Error("math: spec.latex must be a string");
    },
    summarize: (spec) => /** @type {string} */ (spec.latex),
  },
  [BlockKind.Table]: {
    validate(spec) {
      if (
        !Array.isArray(spec.columns) ||
        !spec.columns.every((column) => typeof column === "string") ||
        !Array.isArray(spec.rows) ||
        !spec.rows.every(Array.isArray)
      )
        throw new Error(
          "table: spec.columns must be strings and spec.rows must be arrays",
        );
    },
    summarize: (spec) => /** @type {string[]} */ (spec.columns).join(" · "),
  },
  [BlockKind.Divider]: {
    validate(_spec) {},
    summarize: (_spec) => "Divider",
  },
};

export const blockDefinitions = defineHandlers(BlockKind, definitions);

/**
 * @param {unknown} value
 * @returns {value is (typeof BlockKind)[keyof typeof BlockKind]}
 */
export function isBlockKind(value) {
  return typeof value === "string" && Object.hasOwn(blockDefinitions, value);
}

const alignmentValues = new Set(Object.values(Alignment));

/**
 * @param {unknown} value
 * @returns {value is (typeof Alignment)[keyof typeof Alignment]}
 */
export function isAlignment(value) {
  return (
    typeof value === "string" &&
    alignmentValues.has(
      /** @type {(typeof Alignment)[keyof typeof Alignment]} */ (value),
    )
  );
}

/**
 * @param {unknown} type
 * @param {BlockSpec} spec
 * @returns {void}
 */
export function validateBlockContent(type, spec) {
  if (!isBlockKind(type))
    throw new Error(`Unknown block type: ${String(type)}`);
  blockDefinitions[type].validate(spec);
}
