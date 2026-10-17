# 配置

配置位置：`<agent-dir>/pi-kits.json`，配置键 `subagent`；目录解析、重载与兼容规则见[共享配置](../../../shared/config/README.md)。扩展设置取自[共享 schema](../../../shared/config/schema.ts)，Agent 字段取自[加载器](../agents.ts)，工具字段取自[入口](../index.ts)，执行配置取自 [Pi](../runtime/pi/config.ts) 与 [Codex](../runtime/codex/config.ts)。

| 键 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `subagent.enabled` | boolean | `true` | 控制扩展注册 |
| `subagent.mux` | string | 未设置 | 枚举 `herdr`；启用时显式设置 |
| `subagent.maxConcurrent` | integer | `4` | 限制执行中的受管任务；空闲保留会话不占执行槽 |
| `subagent.extensionAllowlist` | array | `["builtin:codemode", "builtin:tool-search"]` | Pi worker（加载通信桥的子 Pi 进程）加载的扩展列表；整体替换，空数组仅加载通信桥；[解析实现](../runtime/pi/extensions.ts) |
| `extensionAllowlist[].source` | string | 未设置 | 对象条目的 Pi 扩展源；也可直接使用源字符串；相对路径基于 agent 目录 |
| `extensionAllowlist[].extensions` | string[] | 未设置 | 从包的 `extensionResources` 选取资源名；空数组跳过该源 |
| `HERDR_ENV` | 环境变量 | 未设置 | 值为 `1` 时通过 Herdr 环境检查；与 `enabled`、`mux` 共同决定注册；[入口](../index.ts) |
| `HERDR_PANE_ID` | 环境变量 | 未设置 | Herdr 提供的父窗格标识，用于放置视图；[适配器](../mux/herdr.ts) |
| `HERDR_BIN_PATH` | 环境变量 | `herdr` | Herdr CLI 可执行文件路径；[适配器](../mux/herdr.ts) |
| Agent 文件位置 | 路径 | — | `<父工作目录>/.pi/agent/agents/*.md` 与 `<agent-dir>/agents/*.md`；项目同名文件整体覆盖全局文件，名称忽略大小写；列举和创建任务时重新读取 |
| Agent `description` | string | 文件名去掉 `.md` | 类型目录中的说明 |
| Agent `display_name` | string | 类型名 | 界面显示名；[展示实现](../ui/presentation.ts) |
| Agent `runtime` | string | 调用值，再取 `pi` | 执行适配器，即负责启动和控制会话的后端；内置 `pi`、`codex`；注册来源见[管理器](../manager.ts) |
| Agent `model` | string | 调用值，再取后端默认 | Pi 调用缺省时使用父会话模型；Codex 使用自身默认；[入口](../index.ts) |
| Agent `thinking` | string | 调用值，再取后端默认 | Pi 调用缺省时使用父会话等级；Codex 枚举为 `off`、`none`、`minimal`、`low`、`medium`、`high`、`xhigh`，`off` 映射为 `none`；[执行实现](../runtime/codex/index.ts) |
| Agent `enabled` | boolean | `true` | 控制该类型的选用；禁用项仍在目录中显示 |
| Agent `run_in_background` | boolean | 调用值，再取 `true` | 创建和续跑均优先使用 Agent 定义；[入口](../index.ts) |
| Agent `keep_alive` | boolean | 调用值，再取 `false` | 创建时固定的会话保留策略；定义中的显式 `false` 也优先于调用；[管理器](../manager.ts) |
| Agent `runtime_config` | object | 调用会话键，再取后端默认 | 按键覆盖创建调用的会话配置；各后端只解释自身键，忽略其他键；[Pi 测试](../runtime/pi/config.test.ts)、[Codex 测试](../runtime/codex/call-config.test.ts) |
| Agent Markdown 正文 | 文本 | 空 | Pi 按 `prompt_mode` 应用；Codex 作为线程开发者指令；[Pi](../runtime/pi/index.ts)、[Codex](../runtime/codex/index.ts) |
| Pi `runtime_config.tools` | string 或 string[] | Pi 原生选择 | 逗号分隔或数组；`none`、空数组选择零工具；工具名由 Pi 与已加载扩展提供 |
| Pi `runtime_config.disallowed_tools` | string 或 string[] | 无额外排除 | 在工具选择后排除指定工具；[参数构造](../runtime/pi/index.ts) |
| Pi `runtime_config.prompt_mode` | string | `replace` | 命名 Agent 的正文应用模式：`replace` 替换基础系统提示词并屏蔽发现的追加提示词；`append` 保留基础提示词、用正文替换发现的追加提示词；[测试](../manager.test.ts) |
| Pi `runtime_config.inherit_context` | boolean | `false` | 创建入队前冻结父 Pi 当前分支，生成独立子会话；空历史创建新会话，续跑沿用子历史；[克隆测试](../runtime/pi/clone.test.ts)、[继承测试](../runtime/pi/inheritance.test.ts) |
| Codex `runtime_config.runtime_args` | string 或 string[] | `[]` | 逗号分隔或数组；`review` 走原生审阅，`search` 在线程启用实时搜索；其他项转换为 app-server CLI 开关；[转换实现](../runtime/codex/config.ts) |
| Codex `runtime_config.review_target` | object | 未设置 | 每轮审阅从工具调用读取；Agent 文件中的该键被忽略；[调用测试](../runtime/codex/call-config.test.ts) |
| `review_target.type` | string | 未设置 | 全部枚举：`uncommittedChanges`、`baseBranch`、`commit`、`custom`；结构见[审阅 schema](../runtime/codex/schema.ts) |
| `review_target.branch` | string | 未设置 | `baseBranch` 的基准分支 |
| `review_target.sha` | string | 未设置 | `commit` 的提交标识 |
| `review_target.title` | string 或 null | `null` | `commit` 的可选标题 |
| `review_target.instructions` | string | 未设置 | `custom` 的审阅指令；调用的 `prompt` 追加到该指令 |
| 续跑 `runtime_config` | object | 保留会话配置 | 会话键可省略或重复传入归一化后相同的值；每轮任务键重新读取；[Pi 测试](../runtime/pi/config.test.ts)、[Codex 测试](../runtime/codex/call-config.test.ts) |

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
      {
        "source": "<扩展包路径>",
        "extensions": ["<资源名>"]
      }
    ]
  }
}
```

字段校验规则见[共享 schema](../../../shared/config/schema.ts)、[Agent 加载器](../agents.ts)、[Pi 配置解析](../runtime/pi/config.ts)、[Codex 配置解析](../runtime/codex/config.ts)及[审阅 schema](../runtime/codex/schema.ts)；Agent 与工具调用示例见[使用](usage.md)。
