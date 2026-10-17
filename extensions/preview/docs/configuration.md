# 配置

配置位置：`<agent-dir>/pi-kits.json`，配置键 `preview`。目录解析、重载与兼容规则见[共享配置](../../../shared/config/README.md)；共享编辑器键 `terminal.editor` 的类型、默认值和校验规则见 [schema.ts](../../../shared/config/schema.ts)，调用方式见[共享预览实现](../../../shared/readonly-preview.ts)。

| 键 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `enabled` | boolean | `true` | 控制命令和快捷键的注册 |

## 示例

```json
{
  "preview": {
    "enabled": true
  }
}
```

字段的校验规则见 [schema.ts](../../../shared/config/schema.ts)。
