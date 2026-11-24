# 配置

配置分为两处：全局开关与并发数位于 `<agent-dir>/pi-kits.json` 的 `pi-subagent` 键；角色预设位于 `<父工作目录>/.pi/agent/agents/*.md` 和 `<agent-dir>/agents/*.md`。修改 `pi-kits.json` 后重新加载扩展；Agent Markdown 文件在每次调用时实时读取。目录规则见[共享配置](../../../shared/config/README.md)。

| 键 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `pi-subagent.enabled` | boolean | `true` | 控制工具、命令和会话事件的注册 |
| `pi-subagent.maxConcurrent` | integer | `4` | 1–32；限制同时执行中的受管任务数 |
| `pi-subagent.extensionAllowlist` | array | `["builtin:codemode", "builtin:tool-search"]` | 未在 Agent 文件中声明 `extensions` 时的默认子会话扩展列表 |
| `pi-subagent.extensionAllowlist[]` | string 或 object | 未设置 | 字符串为扩展源；对象包含 `source` 与 `extensions` 数组 |
| `HC_TERMINAL_ID` | 环境变量 | 未设置 | 非空时优先选择 `herdr-core` 执行器，通过 PATH 中的 `hc` 管理终端与标签页视图 |
| `HERDR_ENV` | 环境变量 | 未设置 | `HC_TERMINAL_ID` 未匹配且值为 `1` 时选择旧版 `herdr` 执行器；均未匹配时选择后台 `subprocess` 执行器 |
| `HERDR_PANE_ID` | 环境变量 | 未设置 | 旧版 Herdr 的父窗格标识，打开分屏视图时使用 |
| `HERDR_BIN_PATH` | 环境变量 | `herdr` | 旧版 Herdr CLI 路径 |
| Agent 文件位置 | 路径 | — | `<父工作目录>/.pi/agent/agents/*.md` 和 `<agent-dir>/agents/*.md`；项目同名文件整体覆盖全局文件，名称忽略大小写；单文件上限 64 KiB |
| Agent `description` | string | 角色名 | 非空白；角色用途说明，自动注入 `subagent` 工具描述 |
| Agent `display_name` | string | 角色名 | 非空白；界面显示名，未指定角色的任务显示 `Subagent` |
| Agent `model` | string | 父会话模型 | 非空白；形式为 `provider/model-id` |
| Agent `thinking` | string | 父会话等级 | 非空白；传递给子 Pi 的 `--thinking` 参数 |
| Agent `enabled` | boolean | `true` | 控制该角色是否可用 |
| Agent `run_in_background` | boolean | 调用值，再取 `true` | 创建和续跑均优先采用角色定义；`false` 等待本轮结束 |
| Agent `prompt_mode` | string | `replace` | `replace` 替换基础系统提示词并要求正文非空；`append` 保留基础系统提示词并追加正文 |
| Agent `inherit_context` | boolean | `false` | 创建入队前冻结父 Pi 当前分支并生成独立克隆会话文件 |
| Agent `tools` | string 或 string[] | Pi 默认工具 | 逗号分隔或字符串数组；`none` 或空数组禁用全部工具 |
| Agent `disallowed_tools` | string 或 string[] | 无额外排除 | 与 `tools` 相同的列表语法，排除指定工具 |
| Agent `extensions` | array | 全局 `extensionAllowlist` | 该角色显式加载的 Pi 扩展列表，语法同 `pi-subagent.extensionAllowlist` |
| Agent Markdown 正文 | text | 空 | 角色系统指令，`prompt_mode` 为 `replace` 时要求非空 |

## 示例

`pi-kits.json`：

```json
{
  "pi-subagent": {
    "enabled": true,
    "maxConcurrent": 4,
    "extensionAllowlist": [
      "builtin:codemode",
      "builtin:tool-search",
      { "source": "<pi-kits 包路径>", "extensions": ["pi-server-tools", "pi-ask"] }
    ]
  }
}
```

`.pi/agent/agents/explorer.md`：

```markdown
---
description: 快速只读代码搜索与结构梳理
display_name: Explorer
model: <provider>/<model-id>
thinking: low
prompt_mode: append
inherit_context: false
tools: [read, grep, find]
disallowed_tools: [write, edit]
extensions:
  - builtin:tool-search
---
只读探索代码库，给出准确的文件路径和行号摘要。
```

扩展设置的校验规则见 [schema](../../../shared/config/schema.ts)。
