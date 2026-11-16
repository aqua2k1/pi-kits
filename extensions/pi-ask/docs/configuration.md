# 配置

配置位置：`<agent-dir>/pi-kits.json`，配置键 `askUserQuestion`。默认 agent 目录为 `~/.pi/agent`，可由 `PI_CODING_AGENT_DIR` 指定；修改后执行 `/reload`。

| 键 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `askUserQuestion.enabled` | boolean | `true` | 控制工具及活动工具列表协调事件的注册 |

## 示例

```json
{
  "askUserQuestion": {
    "enabled": true
  }
}
```

字段校验规则见 [shared/config/schema.ts](../../../shared/config/schema.ts)。
