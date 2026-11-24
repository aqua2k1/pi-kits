import { type Static, type TProperties, Type } from "typebox";

export const SUBAGENT_DEFAULT_EXTENSIONS = [
  "builtin:codemode",
  "builtin:tool-search",
] as const;

const enabled = Type.Optional(Type.Boolean({ default: true }));
const text = () => Type.String({ minLength: 1, pattern: "\\S" });
const integer = (minimum: number, maximum: number, value?: number) =>
  Type.Optional(
    Type.Integer({
      minimum,
      maximum,
      ...(value === undefined ? {} : { default: value }),
    }),
  );
const section = <P extends TProperties>(properties: P) =>
  Type.Optional(Type.Object(properties, { additionalProperties: true }));
const feature = () => section({ enabled });
const executable = (value: string) =>
  Type.Optional(Type.String({ minLength: 1, pattern: "\\S", default: value }));

const extensionSource = () =>
  Type.String({
    minLength: 1,
    pattern: "^(?=.*\\S)[^\\x00-\\x1f\\x7f]+$",
  });
const WORKER_EXTENSION_SOURCE_SCHEMA = Type.Union([
  extensionSource(),
  Type.Object(
    {
      source: extensionSource(),
      extensions: Type.Array(extensionSource(), { uniqueItems: true }),
    },
    { additionalProperties: true },
  ),
]);
export type WorkerExtensionSource = Static<
  typeof WORKER_EXTENSION_SOURCE_SCHEMA
>;

export const PI_KITS_SCHEMA = Type.Object(
  {
    $schema: Type.Optional(Type.String()),
    "pi-canvas-note": section({
      enabled,
      host: Type.Optional(text()),
      portRange: Type.Optional(
        Type.Tuple(
          [
            Type.Integer({ minimum: 1, maximum: 65_535 }),
            Type.Integer({ minimum: 1, maximum: 65_535 }),
          ],
          { default: [10_000, 20_000] },
        ),
      ),
    }),
    "pi-open": feature(),
    "pi-output-viewer": section({ enabled, editor: executable("nvim") }),
    "pi-ask": feature(),
    "pi-subagent": section({
      enabled,
      maxConcurrent: integer(1, 32, 4),
      extensionAllowlist: Type.Optional(
        Type.Array(WORKER_EXTENSION_SOURCE_SCHEMA, {
          uniqueItems: true,
          description:
            "Pi extension sources or package selections using declared extensionResources names. Relative paths use the agent directory.",
          default: [...SUBAGENT_DEFAULT_EXTENSIONS],
        }),
      ),
    }),
  },
  {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "https://raw.githubusercontent.com/aqua2k1/pi-kits/main/pi-kits.schema.json",
    title: "Pi Kits configuration",
    additionalProperties: true,
  },
);

export type PiKitsFileConfig = Static<typeof PI_KITS_SCHEMA>;
