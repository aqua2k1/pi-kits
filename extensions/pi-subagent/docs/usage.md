# 使用

在 Herdr 内运行 Pi，并在 `<agent-dir>/pi-kits.json` 设置 `{"subagent":{"enabled":true,"mux":"herdr"}}` 后加载扩展。工具由父 Agent 调用；以下 JSON 是工具参数。

## subagent

```json
{
  "description": "<任务标题>", "prompt": "<任务指令>",
  "runtime": "pi", "keep_alive": true,
  "runtime_config": { "tools": ["read"], "inherit_context": true }
}
```
工具创建独立会话，按先入先出顺序执行任务；默认立即返回完整任务 ID。

| 参数 | 说明 |
|---|---|
| `description` | 必填标题，1–200 字符 |
| `prompt` | 普通任务必填非空白指令，最多 100000 字符；Codex 结构化审阅省略此项 |
| `runtime` | `pi`（默认）或 `codex`；命名类型的定义优先 |
| `cwd` | 默认父工作目录；相对路径基于父目录解析，目标必须是已有目录；返回绝对路径并在续跑保留 |
| `model`、`thinking` | 命名类型定义优先，其次调用值；Pi 再取父会话值，Codex 再取自身默认 |
| `subagent_type` | Agent 文件的类型名，忽略大小写；省略时创建匿名会话 |
| `run_in_background` | 默认 `true`；`false` 等待本轮结束；类型定义优先 |
| `keep_alive` | 默认 `false`；`true` 保留完成后的会话；类型定义优先，创建时固定 |
| `runtime_config` | 后端选项；会话键按键优先采用类型定义，每轮审阅目标只取本次调用；完整表见[配置](configuration.md) |

工具命令的 JSON 编码总量限制为 64 KiB，字符数上限内的长指令仍受此限制。

### 命名类型

在 `<父工作目录>/.pi/agent/agents/<类型名>.md` 或 `<agent-dir>/agents/<类型名>.md` 写入：

```markdown
---
description: <类型说明>
display_name: <显示名>
runtime: pi
model: <provider>/<model-id>
thinking: high
enabled: true
run_in_background: true
keep_alive: true
runtime_config: { tools: [read], disallowed_tools: [write, edit],
  prompt_mode: append, inherit_context: false }
---
<角色指令>
```

调用示例：`{"subagent_type":"<类型名>","description":"<任务标题>","prompt":"<任务指令>"}`。
项目同名文件整体覆盖全局文件；每次列举和创建命名任务时重新读取。单个文件上限为 64 KiB，查找位置始终使用父工作目录。
### Codex 审阅与搜索

```json
{
  "runtime": "codex", "description": "<审阅标题>", "keep_alive": true,
  "runtime_config": { "runtime_args": ["review"],
    "review_target": { "type": "baseBranch", "branch": "<基准分支>" } }
}
```
每次创建或续跑审阅任务都提供新的 `review_target`：

| 目标示例 | 范围 |
|---|---|
| `{"type":"uncommittedChanges"}` | 未提交变更 |
| `{"type":"baseBranch","branch":"<基准分支>"}` | 相对基准分支的变更 |
| `{"type":"commit","sha":"<提交标识>","title":"<标题>"}` | 指定提交，标题可省略或为 `null` |
| `{"type":"custom","instructions":"<审阅要求>"}` | 自定义审阅；额外 `prompt` 追加到要求中 |

结构化目标省略 `prompt`；自定义要求使用 `custom.instructions`。审阅目标 JSON 上限为 64 KiB。
搜索示例：`{"runtime":"codex","description":"<搜索标题>","prompt":"<搜索指令>","runtime_config":{"runtime_args":["search"]}}`。`search` 启用实时网页搜索；`review` 使用原生审阅流程。

## get_subagent_result

```json
{ "agent_id": "<完整任务ID>", "wait": true }
```
| 参数 | 说明 |
|---|---|
| `agent_id` | 必填，创建时返回的完整 ID |
| `wait` | 默认立即读取；`true` 等待调用时的受管轮次结束，取消等待保留后台任务 |

受管轮次是父工具派发的一次任务。`status` 为 `queued`、`starting`、`running`、`stopping`、`disconnected`、`completed`、`stopped` 或 `error`；`sessionState` 为 `idle`、`running`、`interactive`、`disconnected` 或 `closed`，启动前可省略。
`result` 保存最新非空的已结束回复；`resultSource` 为 `managed` 或 `user_interaction`，`resultRevision` 记录更新次数，`resultUpdatedAt` 记录更新时间。空回复保留前一结果；`resultOutcome` 为 `completed`、`aborted` 或 `error`，描述该结果的结局。
回复按 UTF-8 限制为 64 KiB 并标记 `truncated`；工具文本另在 24000 字符处截断。完整历史可从返回的 `sessionPath` 读取。
未被等待调用接收的完成结果触发父会话后续轮次；原生交互更新只加入父上下文，保留受管轮次的状态和统计。

## resume_subagent

```json
{ "agent_id": "<完整任务ID>", "prompt": "<后续指令>", "description": "<新标题>", "run_in_background": false }
```
| 参数 | 说明 |
|---|---|
| `agent_id` | 必填；上轮实际结束、会话已连接且空闲时复用 ID、目录、历史和初始类型定义 |
| `prompt` | 普通任务必填；非空白，最多 100000 字符 |
| `description` | 可选新标题，1–200 字符；省略保留原值 |
| `run_in_background` | 默认 `true`；初始类型定义优先 |
| `runtime_config` | 会话键可省略或重复相同的归一化值；审阅目标每轮重新提供 |

审阅续跑示例：`{"agent_id":"<完整任务ID>","runtime_config":{"review_target":{"type":"uncommittedChanges"}}}`。
任务结束后，未启用 `keep_alive`、没有原生交互、没有打开或正在打开的原生视图时释放资源，结果保留、会话变为 `closed`；要续跑，可在创建时设 `keep_alive: true`。

## steer_subagent

```json
{ "agent_id": "<完整任务ID>", "message": "<补充指令>" }
```
| 参数 | 说明 |
|---|---|
| `agent_id` | 必填，已连接且正在执行受管任务的会话 ID |
| `message` | 必填非空白引导，最多 100000 字符，同时受 64 KiB 命令限制 |

## stop_subagent

```json
{ "agent_id": "<完整任务ID>" }
```
| 参数 | 说明 |
|---|---|
| `agent_id` | 必填，取消排队或执行中的受管任务；独立原生交互通过原生终端控制 |

返回后可调用结果工具等待结束；资源清理失败时再次调用可重试。

## list_subagent_types

工具调用示例：`{}`。工具列出命名类型及来源、配置和启用状态；`enabled: false` 的类型仍出现在列表中。

## /subagent:views

```text
/subagent:views
/subagent:views <完整任务ID> open
/subagent:views <完整任务ID> focus
/subagent:views <完整任务ID> close
/subagent:views <完整任务ID> copy
/subagent:views <完整任务ID> stop
/subagent:views <完整任务ID> delete
```

| 参数或交互 | 结果 |
|---|---|
| 省略动作 | 在 Pi 交互界面打开面板；仅传 ID 时预选该任务 |
| `open`、`focus`；Enter、单击任务行 | 打开或聚焦可输入的原生视图；首个在父窗格右侧，后续在最后存活视图下方 |
| `close`；`c` | 关闭视图，执行中的任务继续运行 |
| `copy`；`y` | 复制完整 ID；面板内复制成功后关闭面板 |
| `stop`；`s` | 取消排队或执行中的受管任务，面板保持打开；独立原生交互通过原生终端控制 |
| `delete`；`d` | 确认后清理资源并删除记录，保留会话文件 |
| ↑↓、滚轮、PageUp、PageDown；Esc | 移动选择；关闭面板，删除确认期间 Esc 或 `n` 取消确认 |

编辑器上方状态区显示任务活动和统计，单击可用标题打开视图；完成行保留 5 秒。管理面板本身不保留执行会话。
