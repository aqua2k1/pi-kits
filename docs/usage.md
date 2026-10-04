# Usage extensions

Two independent Pi extensions, `provider-usage` and `stats`. Their individual
and root Pi manifests load only `index.ts`, never tests or shared helper modules.

## Load

From the repository root, try both extensions without changing settings:

```sh
pi -e ./extensions/provider-usage -e ./extensions/stats
```

Or install an individual extension by its local path:

```sh
pi install ./extensions/stats
```

Disable the original extensions before loading the package alongside an existing
personal installation, to avoid duplicate widgets, polling, and commands.

## Provider usage

`/usage` refreshes the below-editor widget on demand. It also refreshes every
10 minutes by default while a supported provider is active:

- `deepseek`: account balance, with a warning when any currency balance is below
  20.
- `openai-codex`: ChatGPT plan usage, with a
  warning when any reported usage window is at least 80% used. Credentials are
  still resolved for `openai-codex`.

Credentials continue to come from Pi's model registry. Missing credentials stop
polling and hide the widget; failed refreshes preserve cached usage as stale.
Settings use the `usage` section of agent-dir `pi-kits.json`. Its `enabled`
switch disables the kit; `providerUsage.enabled` and `stats.enabled` disable
individual entries. `providerUsage.intervalMs` and `timeoutMs` control polling
and request timing. Defaults are 600000 and 15000 ms; edit then `/reload`.
See the [configuration example](../pi-kits.example.json). No new
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
directory. Desktop opening reuses `shared/desktop-open.ts`, including the macOS, Windows,
WSL, and Linux platform policies.

## Tests

The original tests are retained alongside configuration and lifecycle regression
tests. The package test script uses the workspace's `tsx` loader:

```sh
npm test --workspace pi-provider-usage --workspace pi-stats
```

Run these commands from the repository root. Development tooling is managed
there; Pi supplies the declared runtime peer packages.
