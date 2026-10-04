# ask-user-question

## 功能简介

模型工具 `ask_user_question` 支持单选、多选和自定义回答；TUI 使用标签页问卷，RPC 使用原生对话框，非交互模式不注册工具。

## 架构

```mermaid
flowchart LR
  A["模型工具调用"] --> B["问答契约与流程"]
  B --> C["TUI 问卷交互"]
  B --> D["RPC 原生对话框"]
  C --> E["共享面板基础设施"]
  C --> F["结构化回答"]
  D --> F
```

`index.ts` 注册工具和事件；`core.ts` 定义问答契约及 RPC 流程；`tui.ts`、`ui/` 管理交互并复用共享停靠面板。

## 配置

在 agent 目录的 `pi-kits.json` 中设置 `askUserQuestion`，修改后执行 `/reload`。以下为默认值：

```json
{
  "askUserQuestion": {
    "enabled": true
  }
}
```

`multiSelect` 是工具参数，默认 `false`，不是配置项。等待回答通知遵循 `notify.enabled`。操作和事件见[使用说明](docs/usage.md)。

完整字段见[配置示例](../../pi-kits.example.json)。
