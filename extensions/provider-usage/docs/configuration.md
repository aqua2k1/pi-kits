# 配置

配置位置：`<agent-dir>/pi-kits.json`，配置键 `providerUsage`；目录解析、重载和兼容规则见[共享配置](../../../shared/config/README.md)。

| 键 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `enabled` | boolean | `true` | 控制命令和生命周期处理器的注册 |
| `intervalMs` | integer | `600000` | 自动刷新的间隔，单位毫秒 |
| `timeoutMs` | integer | `15000` | 获取凭据后，远程请求的取消计时，单位毫秒 |

## 示例

```json
{
  "providerUsage": {
    "enabled": true,
    "intervalMs": 600000,
    "timeoutMs": 15000
  }
}
```

类型、默认值和校验规则见 [schema.ts](../../../shared/config/schema.ts)，字段行为见 [index.ts](../index.ts)。
