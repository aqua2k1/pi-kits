# 配置

配置位置：`<agent-dir>/pi-kits.json`，配置键 `contextPreview`。目录解析与重载见[共享配置](../../../shared/config/README.md)；编辑器使用[共享配置 schema](../../../shared/config/schema.ts)中的 `terminal.editor`。

| 键 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `contextPreview.enabled` | boolean | `true` | 控制命令、会话重置和请求缓存事件处理器的注册；运行时缓存由命令启动 |

## 示例

```json
{
  "contextPreview": {
    "enabled": true
  }
}
```

字段校验规则见 [shared/config/schema.ts](../../../shared/config/schema.ts)。
