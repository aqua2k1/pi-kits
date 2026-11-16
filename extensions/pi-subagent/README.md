# pi-subagent

`subagent` 把任务交给独立的 Pi 或 Codex 会话，返回结果，并通过 Herdr 打开可交互的原生终端视图。

## 安装

在仓库根目录执行：

```sh
pi install ./extensions/pi-subagent
```

运行需要新版 Herdr app 或旧版 Herdr；Pi 任务使用 PATH 中的 `pi`，Codex 任务使用 `codex`。Codex 的进程清理使用 POSIX 进程组。

## 快速开始

扩展默认启用，无需配置终端适配器。在 Herdr 终端内启动 Pi，让父 Agent 调用 `subagent` 工具：

```json
{
  "description": "<任务标题>",
  "prompt": "<任务指令>"
}
```

工具默认创建 Pi 任务并立即返回完整任务 ID；未被等待调用接收的完成结果向父会话发送后续消息。把 `keep_alive` 设为 `true` 可保留会话供续跑。

在 Pi 交互界面输入以下命令管理任务和视图：

```text
/subagent:views
```

新版 Herdr app 通过任务机器上的 `hc` 请求在父终端工作区的新标签页中显示任务，随后在客户端手动切换；旧版 Herdr 使用相对分屏布局。关闭视图后，执行中的任务继续运行。

启动时自动选择首个匹配环境：`HC_TERMINAL_ID` 非空时优先使用新版 Herdr app，否则在 `HERDR_ENV=1` 时使用旧版 Herdr；均未匹配时不注册。`subagent.enabled` 默认为 `true`，设为 `false` 可关闭扩展；修改配置后重新加载扩展。

## 文档

- [使用](docs/usage.md)
- [配置](docs/configuration.md)
- [架构](docs/architecture.md)
