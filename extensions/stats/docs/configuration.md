# 配置

配置位置：`<agent-dir>/pi-kits.json`，配置键 `stats`；目录解析、重载和兼容规则见[共享配置](../../../shared/config/README.md)。

| 键 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `enabled` | boolean | `true` | 控制 `/stats` 命令的注册 |

## 示例

```json
{
  "stats": {
    "enabled": true
  }
}
```

类型、默认值和校验规则见 [schema.ts](../../../shared/config/schema.ts)，字段行为见 [index.ts](../index.ts)。
