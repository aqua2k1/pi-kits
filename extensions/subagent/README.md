# subagent

`subagent` 将任务交给独立的 Pi 或 Codex 执行会话，并通过 Herdr 管理原生终端视图（[入口](index.ts)、[执行适配](runtime/index.ts)）。

## 安装

在仓库根目录执行：

```sh
pi install ./extensions/subagent
```

扩展入口由[包清单](package.json)声明；运行环境使用 Herdr，Pi 任务调用 `pi`，Codex 任务调用 `codex`（[环境检查](mux/herdr.ts)、[Pi](runtime/pi/index.ts)、[Codex](runtime/codex/index.ts)）。

## 快速开始

在 `<agent-dir>/pi-kits.json` 中设置以下内容，然后在 Herdr 内启动 Pi；配置位置见[共享配置](../../shared/config/README.md)，启用条件见[入口](index.ts)。

```json
{
  "subagent": { "mux": "herdr" }
}
```

让父 Agent 调用 `subagent` 工具：

```json
{
  "description": "检查项目",
  "prompt": "检查当前项目，报告关键文件及测试入口。"
}
```

工具默认立即返回任务 ID；后台任务完成后向父会话发送消息（[工具实现](index.ts)、[完成通知测试](manager.test.ts)）。

## 文档

- [使用](docs/usage.md)
- [配置](docs/configuration.md)
- [架构](docs/architecture.md)
