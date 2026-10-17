# 配置

配置位置：`<agent-dir>/pi-kits.json`，配置键 `askUserQuestion`。目录解析与重载见[共享配置](../../../shared/config/README.md)；等待回答的通知开关见[共享通知配置](../../notify/docs/configuration.md)。

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
