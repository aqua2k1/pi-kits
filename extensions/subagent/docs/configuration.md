# 配置

配置位置：`<agent-dir>/pi-kits.json`，配置键 `subagent`；共享配置负责校验和默认化，修改后重新加载扩展。目录及兼容规则见[共享配置](../../../shared/config/README.md)。

| 键 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `subagent.enabled` | boolean | `true` | 控制工具、命令和会话事件的注册 |
| `subagent.mux` | string | 未设置 | 唯一取值 `herdr`；显式设置后通过 Herdr 环境检查才注册 |
| `subagent.maxConcurrent` | integer | `4` | 1–32；限制执行中的受管任务，空闲保留会话不占执行槽 |
| `subagent.extensionAllowlist` | array | `["builtin:codemode", "builtin:tool-search"]` | Pi 子会话显式加载的扩展；整体替换，空数组只保留任务通信扩展；条目唯一 |
| `subagent.extensionAllowlist[]` | string 或 object | 未设置 | 字符串为扩展源；对象同时包含 `source`、`extensions` |
| `subagent.extensionAllowlist[].source` | string | 未设置 | 非空白、无控制字符；相对路径基于 agent 目录；Pi 解析本地路径、内置源及包源 |
| `subagent.extensionAllowlist[].extensions` | string[] | 未设置 | 唯一的非空白、无控制字符资源名；按包声明的 `extensionResources` 选择，空数组跳过该源 |
| `HERDR_ENV` | 环境变量 | 未设置 | Herdr 提供；值为 `1` 时通过环境检查 |
| `HERDR_PANE_ID` | 环境变量 | 未设置 | Herdr 提供的父窗格标识；打开视图时使用 |
| `HERDR_BIN_PATH` | 环境变量 | `herdr` | Herdr CLI 路径 |
| Agent 文件位置 | 路径 | — | `<父工作目录>/.pi/agent/agents/*.md` 和 `<agent-dir>/agents/*.md`；项目同名文件整体覆盖全局文件，名称忽略大小写；每次列举和创建命名任务重新读取；单文件上限 64 KiB |
| Agent `description` | string | 类型名 | 非空白；类型列表中的说明；类型名取文件名去掉 `.md` |
| Agent `display_name` | string | 类型名 | 非空白；界面显示名，匿名任务显示 `Subagent` |
| Agent `runtime` | string | 调用值，再取 `pi` | 非空白；内置后端为 `pi`、`codex`；定义优先于调用 |
| Agent `model` | string | 调用值，再取后端默认 | 非空白；Pi 调用缺省时取父会话模型，形式为 `provider/model-id`；Codex 取自身默认 |
| Agent `thinking` | string | 调用值，再取后端默认 | 非空白；Pi 调用缺省时取父会话等级并交给 Pi 校验；Codex 取值 `off`、`none`、`minimal`、`low`、`medium`、`high`、`xhigh`，`off` 映射为 `none`，启动时核对模型能力 |
| Agent `enabled` | boolean | `true` | 控制类型选用；禁用项仍列出 |
| Agent `run_in_background` | boolean | 调用值，再取 `true` | 创建和续跑均优先采用初始类型定义；`false` 等待本轮结束 |
| Agent `keep_alive` | boolean | 调用值，再取 `false` | 定义中的显式 `false` 也优先于调用；创建时固定，保留完成后的会话 |
| Agent `runtime_config` | object | `{}` | 普通对象；创建时会话键按键覆盖调用值；各后端解释自身字段 |
| Agent Markdown 正文 | text | 空 | Pi 作为角色指令，默认替换模式要求非空；Codex 作为线程开发者指令 |
| Pi `runtime_config.tools` | string 或 string[] | Pi 原生选择 | 逗号分隔或数组，去空白、空项和重复；`none` 字符串或空数组选择零工具；名称取自 Pi 与加载的扩展 |
| Pi `runtime_config.disallowed_tools` | string 或 string[] | 无额外排除 | 与 `tools` 相同的列表语法；在工具选择后排除这些名称 |
| Pi `runtime_config.prompt_mode` | string | `replace` | 仅用于命名类型；`replace` 替换基础系统提示词并清空发现的追加提示词；`append` 保留基础提示词，用正文替换发现的追加提示词 |
| Pi `runtime_config.inherit_context` | boolean | `false` | 创建入队前冻结父 Pi 当前分支并生成独立子会话；空历史创建新会话，续跑沿用子历史 |
| Codex `runtime_config.runtime_args` | string 或 string[] | `[]` | 逗号分隔或数组，去重；每项非空且无控制字符；`review` 使用原生审阅，`search` 启用实时网页搜索；其他项转为 CLI 开关，值写成 `--flag=value` |
| Codex `runtime_config.review_target` | object | 未设置 | 仅从每次工具调用读取；`runtime_args` 含 `review` 时每轮必填，Agent 文件中的值忽略 |
| `review_target.type` | string | 未设置 | 必填；`uncommittedChanges`、`baseBranch`、`commit`、`custom` |
| `review_target.branch` | string | 未设置 | `baseBranch` 必填非空白基准分支 |
| `review_target.sha` | string | 未设置 | `commit` 必填非空白提交标识 |
| `review_target.title` | string 或 null | `null` | `commit` 的可选标题 |
| `review_target.instructions` | string | 未设置 | `custom` 必填非空白审阅要求，调用的 `prompt` 追加到此字段；其他目标省略 `prompt` |
| 续跑 `runtime_config` | object | 保留会话键 | Pi 的四个配置键和 Codex 的 `runtime_args` 可省略或重复归一化后相同的值；`review_target` 每轮重新提供 |

## 示例

```json
{
  "subagent": {
    "enabled": true,
    "mux": "herdr",
    "maxConcurrent": 4,
    "extensionAllowlist": [
      "builtin:codemode",
      "builtin:tool-search",
      { "source": "<扩展包路径>", "extensions": ["<资源名>"] }
    ]
  }
}
```

扩展设置的校验规则见 [schema](../../../shared/config/schema.ts)。
