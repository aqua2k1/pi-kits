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
  Type.Optional(Type.Object(properties, { additionalProperties: false }));
const feature = () => section({ enabled });
const executable = (value: string) =>
  Type.Optional(Type.String({ minLength: 1, pattern: "\\S", default: value }));
const provider = () =>
  Type.Union([
    Type.Literal("searxng"),
    Type.Literal("codex-alpha-search"),
    Type.Literal("codex"),
  ]);

export const PI_KITS_SCHEMA = Type.Object(
  {
    $schema: Type.Optional(Type.String()),
    workspace: section({
      enabled,
      terminal: section({
        enabled,
        editor: executable("nvim"),
        gitUI: executable("lazygit"),
        fileManager: executable("yazi"),
      }),
      open: feature(),
      preview: feature(),
      contextPreview: feature(),
    }),
    usage: section({
      enabled,
      providerUsage: section({
        enabled,
        intervalMs: integer(1_000, 2_147_483_647, 600_000),
        timeoutMs: integer(100, 300_000, 15_000),
      }),
      stats: feature(),
    }),
    workflow: section({
      enabled,
      askUserQuestion: feature(),
      subagent: section({
        enabled,
        mux: Type.Optional(Type.Literal("herdr")),
        maxConcurrent: integer(1, 32, 4),
        extensionAllowlist: Type.Optional(
          Type.Array(
            Type.String({
              minLength: 1,
              pattern: "^(?=.*\\S)[^\\x00-\\x1f\\x7f]+$",
            }),
            {
              uniqueItems: true,
              description:
                "Pi extension sources resolved by Pi. Relative paths use the agent directory.",
              default: [...SUBAGENT_DEFAULT_EXTENSIONS],
            },
          ),
        ),
      }),
      commit: section({
        enabled,
        model: Type.Optional(text()),
        lastModel: Type.Optional(text()),
        thinking: Type.Optional(text()),
        timeoutMs: integer(1_000, 2_147_483_647, 120_000),
        rememberModel: Type.Optional(Type.Boolean({ default: true })),
      }),
      notify: section({
        enabled,
        quietPeriodMs: integer(0, 60_000, 1_000),
      }),
    }),
    web: section({
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
        codex: section({
          model: Type.Optional(
            Type.String({
              pattern: "^[a-zA-Z0-9._-]+$",
              minLength: 1,
              maxLength: 128,
              default: "gpt-5.4",
            }),
          ),
        }),
      }),
      fetch: section({
        enabled,
        timeoutMs: integer(1_000, 120_000, 15_000),
        github: section({
          enabled: Type.Optional(Type.Boolean()),
          mode: Type.Optional(
            Type.Union([
              Type.Literal("auto"),
              Type.Literal("clone"),
              Type.Literal("api"),
            ]),
          ),
          maxRepoSizeMB: integer(1, 10_240),
          cloneTimeoutSeconds: integer(5, 600),
          clonePath: Type.Optional(text()),
        }),
      }),
    }),
  },
  {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "https://raw.githubusercontent.com/aqua2k1/pi-kits/main/pi-kits.schema.json",
    title: "Pi Kits configuration",
    additionalProperties: false,
  },
);

export type PiKitsFileConfig = Static<typeof PI_KITS_SCHEMA>;
