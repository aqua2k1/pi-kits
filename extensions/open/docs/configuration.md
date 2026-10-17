# 配置

配置位置：`<agent-dir>/pi-kits.json`，配置键 `open`。目录解析、重载与兼容规则见[共享配置](../../../shared/config/README.md)。

| 键 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `enabled` | boolean | `true` | 控制命令和工具的注册 |

## 示例

```json
{
  "open": {
    "enabled": true
  }
}
```

字段的校验规则见 [schema.ts](../../../shared/config/schema.ts)。
