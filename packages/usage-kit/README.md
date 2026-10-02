# pi-usage-kit

Two independent Pi extensions, copied from the existing `provider-usage` and
`stats` extensions. The explicit Pi manifest loads only their `index.ts` entry
points, never their tests or helper modules. Neither entry point depends on
another kit's runtime.

## Load

From this package directory, try both extensions without changing settings:

```sh
pi -e ./src/extensions/provider-usage/index.ts -e ./src/extensions/stats/index.ts
```

Or install the package by its local path:

```sh
pi install /absolute/path/to/packages/usage-kit
```

Disable the original extensions before loading the package alongside an existing
personal installation, to avoid duplicate widgets, polling, and commands.

## Provider usage

`/usage` refreshes the below-editor widget on demand. It also refreshes every
10 minutes by default while a supported provider is active:

- `deepseek`: account balance, with a warning when any currency balance is below
  20.
- `openai-codex` (also selected by the `openai` alias): ChatGPT plan usage, with a
  warning when any reported usage window is at least 80% used. Credentials are
  still resolved for `openai-codex`.

Credentials continue to come from Pi's model registry. Missing credentials stop
polling and hide the widget; failed refreshes preserve cached usage as stale.
Settings use the `usage` section of agent-dir `pi-kits.json`. Its `enabled`
switch disables the kit; `providerUsage.enabled` and `stats.enabled` disable
individual entries. `providerUsage.intervalMs` and `timeoutMs` control polling
and request timing. Defaults are 600000 and 15000 ms; edit then `/reload`.
See the [configuration example](../../pi-kits.example.json). No new
authentication paths are introduced.

## Session statistics

`/stats` scans session snapshots and opens a self-contained HTML report with
model totals, costs, daily usage, and rolling 30-day / 24-hour totals. The original
`template.html` remains next to `html.ts` and is included in the package.

Session-directory selection is unchanged: the default cwd-specific directory
expands to all sessions under `getAgentDir()/sessions`; a custom session directory
remains scoped to that directory. `getAgentDir()` continues to respect Pi's agent
directory configuration (normally `~/.pi/agent`, overridable with
`PI_CODING_AGENT_DIR`). Reports are written to an OS temporary `pi-stats-*`
directory. Desktop opening retains the existing `open`, `rundll32`, or `xdg-open`
implementation; it has not been moved to a shared kit.

## Tests

The original tests are retained alongside configuration and lifecycle regression
tests. The package test script uses the workspace's `tsx` loader:

```sh
npm test --workspace pi-usage-kit
```

From this directory, `npm test` runs the same suite. Development tooling is
managed by the workspace root; Pi supplies the declared runtime peer packages.
