# Commit 使用说明

## Commit workflow

`/commit` lists and confirms staged files, chooses a model (a fuzzy picker in
TUI, plain selection in RPC), and generates a Conventional Commits message using
a tool-less `pi -p` child process. Review the generated message, regenerate it,
cancel, or submit it with `git commit -m`.

`pi --commit` dispatches `/commit` only during startup. Pi shuts down only after
a successful startup-triggered commit; cancellations and failures do not exit.
Non-interactive modes do not execute the commit flow.

Model memory is stored in `commit.lastModel` inside
`<agent-dir>/pi-kits.json`, honoring `PI_CODING_AGENT_DIR` (including `~`
expansion). Updates preserve other configuration fields. Legacy
`extensions/commit/last_model.json` is ignored and never migrated or modified.

`commit.model` 优先于已记忆模型和当前模型；`thinking` 控制生成思考级别，`timeoutMs` 默认 120000。`rememberModel: false` 禁止读写 `lastModel`。完成通知遵循 `notify.enabled`。
