# AGENTS.md

## Project

Four Pi kits live under `packages/`: workspace, usage, workflow, and web.
Keep extension entry points explicit in both root and kit Pi manifests.
Shared helpers must not register commands, tools, or lifecycle handlers.
Settings live in agent-dir `pi-kits.json`; use `@pi-kits/config` for validation
and defaults. Keep the exported JSON schema and example in sync.

## Validation

- `npm test` → Unit tests and isolated Pi loading checks
- `npm run typecheck` → TypeScript validation

## Biome Workflow

We use Biome for formatting, linting, and import sorting.

1. Run tests, typecheck, and `npx biome check .` (read-only).
2. **Only after checks pass**, run `npx biome format --write .`.
3. Commit the formatted code.

- **Never** format before checks pass.
- **Never** use `--write` in CI; use `npx biome ci .`.
- Configuration lives in `biome.json`.
