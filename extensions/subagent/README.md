# subagent

`subagent` 把任务交给独立的 Pi 或 Codex 会话，返回结果，并通过 Herdr 打开可交互的原生终端视图。

## 安装

在仓库根目录执行：

```sh
pi install ./extensions/subagent
```

运行需要 Herdr；Pi 任务使用 PATH 中的 `pi`，Codex 任务使用 `codex`。Codex 的进程清理使用 POSIX 进程组。

## 快速开始

在 `<agent-dir>/pi-kits.json` 中启用 Herdr：

```json
{
  "subagent": { "mux": "herdr" }
}
```

在 Herdr 终端内启动 Pi，让父 Agent 调用 `subagent` 工具：

```json
{
  "description": "<任务标题>",
  "prompt": "<任务指令>"
}
```

工具默认创建 Pi 任务并立即返回完整任务 ID；未被等待调用接收的完成结果向父会话发送后续消息。把 `keep_alive` 设为 `true` 可保留会话供续跑。

在 Pi 交互界面输入以下命令查看任务并打开原生终端：

```text
/subagent:views
```

扩展在 `subagent.enabled` 为 `true`、`subagent.mux` 为 `herdr` 且 Herdr 环境标记为 `1` 时注册；修改配置后重新加载扩展。

## 文档

- [使用](docs/usage.md)
- [配置](docs/configuration.md)
- [架构](docs/architecture.md)
