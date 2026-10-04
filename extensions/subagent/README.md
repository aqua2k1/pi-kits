# Subagent

## 功能简介

通过 Herdr 原生 Pi 终端执行独立任务，默认后台运行。
支持自定义 Markdown agent、父上下文克隆、引导、取消及保留会话续跑。
提供六个工具：`subagent`、`resume_subagent`、`list_subagent_types`、
`get_subagent_result`、`steer_subagent`、`stop_subagent`。
TUI 使用 `/subagent:views` 管理终端视图，编辑器上方显示实时任务状态。
不支持调度、worktree、跨进程恢复或自动重连；worker 不是沙箱。

## 架构

```mermaid
flowchart LR
  A["父会话工具与视图"] --> B["任务调度与生命周期"]
  C["Agent 定义与上下文策略"] --> B
  B <-->|"任务与状态通信"| D["Worker 会话"]
  B --> E["终端与视图适配"]
  E --> F["原生终端宿主"]
  F --> D
```

- [index.ts](index.ts)：启用检查、工具/命令注册、会话生命周期与完成消息。
- [manager.ts](manager.ts)：任务轮次、FIFO 并发队列、IPC、worker 与视图管理。
- [mux.ts](mux.ts) / [herdr.ts](herdr.ts)：终端适配接口与 Herdr 实现，不自建 PTY。
- [worker.ts](worker.ts) / [protocol.ts](protocol.ts)：认证的 loopback TCP JSONL 桥接。
- [agents.ts](agents.ts) / [clone.ts](clone.ts)：用户定义加载与独立 Pi 分支克隆。
- `views.ts`、`status-widget.ts`、`presentation.ts`、`renderers.ts`：TUI 展示。

包 manifest 仅加载 `index.ts`；worker 由子 Pi 显式通过 `-e` 加载。
完成的终端保留供查看/续跑；关闭视图仅脱离，父会话退出或重载清理 worker。

## 配置

在 agent 目录的 `pi-kits.json` 中配置，修改后执行 `/reload`：

```json
{
  "subagent": {
    "mux": "herdr",
    "enabled": true,
    "maxConcurrent": 4,
    "extensionAllowlist": ["builtin:codemode", "builtin:tool-search"]
  }
}
```

须显式设置 `mux: "herdr"` 且 `HERDR_ENV === "1"`；否则不注册工具、命令或钩子。
`enabled` 默认 `true`；`maxConcurrent` 为 1–32 的整数，默认 4，仅限制执行任务。
allowlist 整体替换默认值，`[]` 只加载 worker 桥；详见[使用文档](docs/usage.md)与[配置示例](../../pi-kits.example.json)。
