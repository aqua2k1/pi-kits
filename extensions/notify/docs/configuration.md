# 配置

配置位置：`<agent-dir>/pi-kits.json`，配置键 `notify`。目录解析、重载与兼容规则见[共享配置](../../../shared/config/README.md)。

| 键 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `enabled` | boolean | `true` | 控制通知生命周期处理器的注册 |
| `quietPeriodMs` | integer | `1000` | 任务结束后等待空闲的毫秒数 |

## 示例

```json
{
  "notify": {
    "enabled": true,
    "quietPeriodMs": 1000
  }
}
```

字段的校验规则见 [schema.ts](../../../shared/config/schema.ts)。
