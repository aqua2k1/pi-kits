# 使用

## subagent

将以下 JSON 作为工具参数，创建独立任务（[实现](../index.ts)）：

```json
{
  "description": "检查项目", "prompt": "检查代码并报告文件与测试依据。",
  "runtime": "pi", "cwd": "<已有目录>",
  "model": "<provider>/<model-id>", "thinking": "high",
  "run_in_background": true, "keep_alive": true,
  "runtime_config": { "tools": ["read"], "inherit_context": true }
}
```

| 参数 | 说明 |
|---|---|
| `description`、`prompt` | 任务标题和指令；普通任务使用 `prompt`，原生审阅示例见下文 |
| `runtime`、`model`、`thinking` | 选择执行后端、模型和思考等级；字段优先级见[配置](configuration.md) |
| `cwd` | 默认父工作目录，相对路径基于父目录解析；返回绝对目录，续跑保留；Agent 定义仍从父目录查找；[测试](../index.test.ts) |
| `run_in_background` | 默认立即返回 ID，设为 `false` 等待本轮结束；[实现](../index.ts) |
| `keep_alive`、`runtime_config` | 会话保留与后端专属选项，作用域及默认值见[配置](configuration.md) |
| `subagent_type` | 选择 Markdown Agent 文件定义的命名类型；加载规则见[配置](configuration.md) |

例如在 `.pi/agent/agents/<类型名>.md` 中写入 YAML 元数据区（frontmatter，即两行 `---` 之间的配置）和正文，再以 `{"subagent_type":"<类型名>","description":"检查项目","prompt":"检查当前代码。"}` 调用（[加载器](../agents.ts)、[测试](../agents.test.ts)）：

```markdown
---
description: 检查代码
display_name: 检查员
runtime: pi
model: <provider>/<model-id>
thinking: high
enabled: true
run_in_background: true
keep_alive: true
runtime_config: { tools: [read], disallowed_tools: [write, edit],
  prompt_mode: append, inherit_context: false }
---
检查任务指定的代码，报告文件路径和证据。
```

创建 Codex 原生审阅任务时使用以下参数；每次续跑都重新提供审阅目标（[解析与测试](../runtime/codex/call-config.test.ts)）：

```json
{
  "runtime": "codex", "description": "审阅变更", "keep_alive": true,
  "runtime_config": { "runtime_args": ["review"],
    "review_target": { "type": "baseBranch", "branch": "<基准分支>" } }
}
```

| `review_target` 示例 | 审阅范围（[schema](../runtime/codex/schema.ts)、[解析](../runtime/codex/config.ts)） |
|---|---|
| `{"type":"uncommittedChanges"}` | 未提交变更 |
| `{"type":"commit","sha":"<提交标识>","title":"<标题>"}` | 指定提交 |
| `{"type":"custom","instructions":"<审阅要求>"}` | 自定义要求；额外 `prompt` 追加到要求中 |

结构化目标省略 `prompt`；定制审阅要求放入 `custom.instructions`（[任务解析](../runtime/codex/config.ts)）。普通 Codex 搜索任务使用 `{"runtime":"codex","description":"检索资料","prompt":"<检索任务>","runtime_config":{"runtime_args":["search"]}}`；`search` 在线程设置实时搜索，审阅仍交给原生审阅流程（[实现](../runtime/codex/index.ts)）。

## get_subagent_result

读取任务状态和最新已结束回复（[实现](../index.ts)、[结果测试](../manager.test.ts)）。

```json
{ "agent_id": "<任务ID>", "wait": true }
```

| 参数 | 说明 |
|---|---|
| `agent_id` | 创建时返回的完整 ID |
| `wait` | 省略时立即读取；`true` 等待调用时的受管轮次结束；取消等待保留后台任务；[测试](../lifecycle.test.ts) |

受管轮次指父工具派发的一次任务：`status` 表示轮次状态，`sessionState` 表示后端会话状态，枚举见 [state.ts](../state.ts)。`result` 是受管任务或原生用户交互的最新回复；`resultSource` 区分来源，`resultRevision` 记录发布次数，`resultUpdatedAt` 记录发布时间（[管理器](../manager.ts)）。

回复按 UTF-8 截断并标记 `truncated`；完整会话保存在 `sessionPath` 指向的文件，工具文本还设有展示截断（[入口](../index.ts)、[Pi 测试](../runtime/pi/worker.test.ts)、[Codex 测试](../runtime/codex/index.test.ts)）。后台完成消息触发父会话后续轮次；原生交互消息只加入父上下文（[通知测试](../index.test.ts)）。

## resume_subagent

在保留的空闲、已连接会话中继续任务，沿用 ID、目录、历史和初始 Agent 定义（[管理器](../manager.ts)、[测试](../manager.test.ts)）。

```json
{ "agent_id": "<任务ID>", "prompt": "继续检查测试。", "description": "检查测试", "run_in_background": false }
```

| 参数 | 说明 |
|---|---|
| `agent_id`、`prompt` | 会话 ID 与新任务；上轮实际结束后才能续跑；[策略](../policy.ts) |
| `description`、`run_in_background` | 省略标题保留原值；后台偏好优先使用初始 Agent 定义；[入口](../index.ts) |
| `runtime_config` | 会话键保持不变；审阅续跑示例：`{"agent_id":"<任务ID>","runtime_config":{"review_target":{"type":"uncommittedChanges"}}}`；[配置](configuration.md) |

任务结束、会话不在原生交互中、没有打开或正在打开的原生视图且未启用 `keep_alive` 时，管理器释放执行资源并保留结果；释放后会话显示 `closed`。管理面板本身不保留会话（[释放策略](../policy.ts)、[视图与释放测试](../manager-runtime.test.ts)）。

## steer_subagent

向当前已连接、运行中的受管任务发送引导；原生交互状态下由会话策略阻止投递（[策略](../policy.ts)、[测试](../policy.test.ts)）。

```json
{ "agent_id": "<任务ID>", "message": "优先检查错误处理路径。" }
```

| 参数 | 说明 |
|---|---|
| `agent_id`、`message` | 当前任务 ID 与补充指令；[工具实现](../index.ts) |

## stop_subagent

取消排队或执行中的受管任务；调用返回后可用结果工具等待结束，清理失败时再次调用可重试清理（[管理器](../manager.ts)、[生命周期测试](../lifecycle.test.ts)）。

```json
{ "agent_id": "<任务ID>" }
```

| 参数 | 说明 |
|---|---|
| `agent_id` | 要停止的任务；独立原生交互由原生终端控制；[入口](../index.ts) |

## list_subagent_types

```json
{}
```

列举命名类型及来源、配置和启用状态（[工具实现](../index.ts)、[目录测试](../index.test.ts)）。

## /subagent:views

在 Pi 文本交互界面（TUI）管理原生终端视图；视图是可输入的原生终端连接（[入口](../index.ts)、[终端接口](../mux/index.ts)）。

```text
/subagent:views
/subagent:views <任务ID> open
/subagent:views <任务ID> focus
/subagent:views <任务ID> close
/subagent:views <任务ID> copy
/subagent:views <任务ID> delete
```

| 参数或交互 | 结果（[入口](../index.ts)、[面板](../ui/views.ts)、[测试](../ui/components.test.ts)） |
|---|---|
| 省略动作 | 打开面板；仅传 ID 时预选该任务 |
| `open`、`focus`；Enter、单击任务行 | 打开或聚焦视图；首个在父窗格右侧，后续在最后存活视图下方；[布局测试](../manager.test.ts) |
| `close`；`c` | 脱离视图，执行中的任务继续运行 |
| `copy`；`y` | 复制完整 ID；面板内复制成功后关闭面板 |
| `delete`；`d` | 确认后清理资源并删除记录，保留会话文件 |
| ↑↓、滚轮；Esc | 选择任务；关闭面板，删除确认期间 Esc 仅取消确认 |

编辑器上方状态区显示活动与统计，单击可用的任务标题打开视图；任务结束后短暂保留状态行（[状态组件](../ui/status-widget.ts)、[点击测试](../ui/status-widget-click.test.ts)）。共享面板和渲染能力见[共享库](../../../shared/README.md)。
