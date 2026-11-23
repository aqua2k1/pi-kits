# 使用

扩展默认启用，启动时按环境自动选择宿主执行器：优先匹配非空的 `HC_TERMINAL_ID`（新版 Herdr core），其次匹配 `HERDR_ENV=1`（旧版 Herdr），均未匹配时使用后台 `subprocess`。两个工具由父 Agent 调用，每次返回均附带针对当前状态的下一步 `hint`。

## subagent

派发新任务、向运行中任务追加引导（Steer），或在同一会话上续跑后续任务（Resume）。

```json
{
  "prompt": "<任务指令>",
  "agent": "<角色类型名>",
  "description": "<任务标题>",
  "background": true
}
```

向已有任务继续发送指令：

```json
{
  "id": "sub-1",
  "prompt": "<补充引导或后续指令>"
}
```

| 参数 | 说明 |
|---|---|
| `prompt` | 必填，非空白任务指令、后续请求或运行中引导，最多 100000 字符 |
| `id` | 可选，已有任务短 ID（如 `sub-1`）；省略时创建新会话，传入时运行中自动 Steer、已结束自动按原会话文件 Resume |
| `agent` | 可选，Agent 文件定义的角色名，忽略大小写；已启用的角色自动列在工具说明中 |
| `description` | 可选，简短标题，1–200 字符；省略时默认取 `prompt` 首行摘要，续跑省略保留原值 |
| `cwd` | 可选，新建会话的工作目录，默认父工作目录；相对路径基于父目录解析，续跑时保持不变 |
| `background` | 默认 `true`（立即返回 ID）；设为 `false` 等待本轮完成直接返回结果；角色定义中的 `run_in_background` 优先 |

工具命令的 JSON 编码总量上限为 64 KiB。后台子进程（`subprocess`）或未打开视图的已完成会话自动释放进程，会话历史保留在 `sessionPath` 中；再次传入同一 `id` 调用 `subagent` 时自动按原 `sessionPath` 重启进程并接续上下文。

### 角色定义

在 `<父工作目录>/.pi/agent/agents/<角色名>.md` 或 `<agent-dir>/agents/<角色名>.md` 写入：

```markdown
---
description: <角色说明>
display_name: <显示名>
model: <provider>/<model-id>
thinking: high
enabled: true
run_in_background: true
prompt_mode: append
inherit_context: false
tools: [read, grep, find]
disallowed_tools: [write, edit]
extensions:
  - builtin:codemode
  - builtin:tool-search
---
<角色系统指令>
```

项目同名文件整体覆盖全局文件；单文件上限为 64 KiB。完整字段说明见[配置](configuration.md)。

## subagent_ctl

等待任务完成、立即读取状态或停止任务。

```json
{
  "id": "sub-1",
  "action": "wait"
}
```

| 参数 | 说明 |
|---|---|
| `id` | 必填，`subagent` 返回的任务 ID（如 `sub-1`） |
| `action` | 必填：`wait` 阻塞等待当前轮结束并返回结果；`status` 立即返回当前状态与最新结果；`stop` 取消排队或运行中的当前轮 |

`status` 为 `queued`、`starting`、`running`、`stopping`、`disconnected`、`completed`、`stopped` 或 `error`；`sessionState` 为 `idle`、`running`、`interactive`、`disconnected` 或 `closed`。`result` 保存最新非空回复，按 UTF-8 限制为 64 KiB 并标记 `truncated`；完整历史可从返回的 `sessionPath` 读取。未被 `wait` 接收的后台完成结果自动触发父会话后续消息。

## /subagent:views

```text
/subagent:views
/subagent:views sub-1 open
/subagent:views sub-1 focus
/subagent:views sub-1 close
/subagent:views sub-1 copy
/subagent:views sub-1 stop
/subagent:views sub-1 delete
```

| 参数或交互 | 结果 |
|---|---|
| 省略动作 | 在 Pi 交互界面打开面板；仅传 ID 时预选该任务 |
| `open`、`focus`；Enter、单击任务行 | 在 Herdr 环境下打开或聚焦原生终端视图；`subprocess` 模式下不可用 |
| `close`；`c` | 关闭终端视图，执行中的任务继续运行 |
| `copy`；`y` | 复制任务 ID；面板内复制成功后关闭面板 |
| `stop`；`s` | 取消排队或执行中的受管任务，面板保持打开 |
| `delete`；`d` | 确认后清理资源并删除记录，保留会话文件 |
| ↑↓、滚轮、PageUp、PageDown；Esc | 移动选择；关闭面板 |
