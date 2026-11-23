# pi-subagent

`subagent` 把任务交给独立的 Pi 子会话执行并返回结果，在 Herdr 内打开可交互的原生终端视图，其他环境下自动回退到后台子进程。两个工具 `subagent` 与 `subagent_ctl` 归于 `pi-subagent` namespace。

## 安装

在仓库根目录执行：

```sh
pi install ./extensions/pi-subagent
```

扩展默认启用，使用 PATH 中的 `pi`。启动时按环境自动选择宿主执行器：`HC_TERMINAL_ID` 非空时使用 `herdr-core`，否则使用 `subprocess` 后台进程组。

## 快速开始

让父 Agent 调用 `subagent` 工具启动任务：

```json
{
  "prompt": "<任务指令>"
}
```

工具立即返回短任务 ID（如 `sub-1`）和下一步操作 `hint`；向同一 `id` 再次调用 `subagent` 时，运行中自动引导（Steer），已结束则按保存的会话文件自动续跑（Resume）。使用 `subagent_ctl` 等待结果、查看状态或停止任务：

```json
{
  "id": "sub-1",
  "action": "wait"
}
```

在 Pi 交互界面输入以下命令管理任务和终端视图：

```text
/subagent:views
```

`pi-subagent.enabled` 默认为 `true`，设为 `false` 可关闭扩展；修改配置后执行 `/reload`。

## 文档

- [使用](docs/usage.md)
- [配置](docs/configuration.md)
- [架构](docs/architecture.md)
