# AGENTS.md

## Layout

- `extensions/<name>/` — independent Pi extensions
- `shared/` — shared helpers (`@pi-kits/shared`)
- `themes/` — themes
- `docs/writing-docs.md` — documentation rules

## Rules

- Keep extension entry points explicit in both the root and each extension's Pi manifest.
- Declare logical resource names in package metadata, never in resolver special cases.
- Shared helpers do not register commands, tools, or lifecycle handlers.

## Docs

Read `docs/writing-docs.md` before writing or editing docs.
Before changing an extension, read its `README.md`; if `docs/architecture.md`
exists, read that too.

## Validation

- `npm test` — unit tests and isolated Pi loading checks
- `npm run typecheck` — TypeScript validation
- `npx biome check .` — format, lint, import sorting (CI uses `npx biome ci .`)

Fix formatting with `npx biome check --write .`, then rerun the three commands above before committing.
