# 架构

入口协调暂存区确认、模型选择、生成和提交；核心逻辑执行 Git 与生成子进程，界面负责交互。共享配置负责校验和原子更新，通知由共享库发送，细节见[共享配置](../../../shared/config/README.md)与[共享库](../../../shared/README.md)。

## 模块关系

```mermaid
flowchart LR
  index["index.ts<br/>入口与编排"] --> core["core.ts<br/>Git、生成和模型记忆"]
  index --> ui["ui.ts<br/>模型选择与消息审阅"]
  ui --> core
```

## 文件地图

| 文件 | 职责 |
|---|---|
| `index.ts` | 注册命令、启动标志与事件，协调生成、审阅和提交 |
| `core.ts` | 读取暂存区、构造生成任务与参数、执行子进程、清理输出、记忆模型 |
| `ui.ts` | TUI 模糊搜索、消息预览和操作选择；RPC 选择框 |

## 数据流

```mermaid
sequenceDiagram
  actor User as 用户
  participant Entry as index.ts
  participant UI as ui.ts
  participant Core as core.ts
  participant Generator as pi 生成子进程
  User->>Entry: /commit
  Entry->>Core: 读取暂存文件
  Core-->>Entry: 文件列表
  Entry->>User: 确认暂存文件
  User-->>Entry: 确认
  Entry->>UI: 选择模型
  UI-->>Entry: 模型标识
  Entry->>Core: 文件列表、最新 diff、模型与配置
  Core->>Generator: 系统提示词与 stdin 任务
  Generator-->>Core: 提交信息
  Core-->>Entry: 生成结果
  Entry->>UI: 审阅完整消息
  UI-->>Entry: 提交操作
  Entry->>Core: git commit -m 完整消息
  Core-->>Entry: 提交结果
  Entry-->>User: 结果通知
```

取消或失败时结束流程；重新生成保留模型并重读 diff；启动标志触发的本次提交成功后退出 Pi。

## 约束

- Git 读取、生成与提交共用 `ctx.cwd`，保证操作作用于同一工作目录。
- `COMMIT_SYSTEM_PROMPT` 集中存放生成规则，`buildTask` 只带文件列表与 diff，避免规则分散后产生分歧。
- `buildPiArgs` 保留工具、扩展、技能、上下文文件和会话的隔离标志，防止生成子进程加载这些资源或写入会话。
- 配置模型或记忆模型缺席注册表时仍加入候选，避免用户配置被静默丢弃。
- 模型记忆只在 `rememberModel` 开启时读写，并通过共享配置更新 `commit.lastModel`，保留其他设置。
- TUI 预览仅显示前 15 行，提交始终使用完整消息，防止展示截断改变提交内容。

## 测试

在仓库根目录执行：

```sh
npm test --workspace=pi-commit
```

- `core.test.ts`：暂存状态解析、Git 往返、任务和参数构造、生成成功/失败/超时、围栏清理、模型排序和记忆读写。
- `index.test.ts`：注册与启动条件、交互前提、模型优先级、记忆开关、配置传递与完成通知开关。
