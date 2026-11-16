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
const provider = () =>
  Type.Union([
    Type.Literal("searxng"),
    Type.Literal("codex-alpha-search"),
    Type.Literal("codex"),
  ]);

const searxng = () =>
  section({
    url: Type.Optional(Type.Never()),
    apiKey: Type.Optional(Type.Never()),
  });
const codex = () =>
  section({
    model: Type.Optional(
      Type.String({
        pattern: "^[a-zA-Z0-9._-]+$",
        minLength: 1,
        maxLength: 128,
        default: "gpt-6-luna",
      }),
    ),
  });

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
    "pi-web-kits": section({
      enabled,
      search: section({
        enabled,
        routing: section({
          provider: Type.Optional(provider()),
          fallback: Type.Optional(Type.Boolean()),
          fallbackProvider: Type.Optional(provider()),
        }),
        timeoutMs: integer(1_000, 120_000, 15_000),
        maxResults: integer(1, 10, 5),
        searxng: searxng(),
        // Legacy routing/codex remain readable; sources.web is the current format.
        codex: codex(),
        sources: section({
          web: section({
            enabled,
            searxng: searxng(),
            routing: Type.Optional(
              Type.Array(
                Type.Union([
                  Type.Literal("searxng"),
                  Type.Literal("codex-alpha-search"),
                ]),
                { minItems: 1, uniqueItems: true, default: ["searxng"] },
              ),
            ),
            codex: codex(),
          }),
          github: feature(),
        }),
      }),
      fetch: section({
        enabled,
        timeoutMs: integer(1_000, 120_000, 15_000),
        github: section({
          enabled: Type.Optional(Type.Boolean()),
        }),
      }),
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
