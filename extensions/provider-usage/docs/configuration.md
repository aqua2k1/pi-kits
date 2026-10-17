# 配置

配置位置：`<agent-dir>/pi-kits.json`，配置键 `providerUsage`。默认 agent 目录为 `~/.pi/agent`，可由 `PI_CODING_AGENT_DIR` 指定；修改后执行 `/reload`。

| 键 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `enabled` | boolean | `true` | 控制命令和生命周期处理器的注册 |
| `intervalMs` | integer | `600000` | 自动刷新间隔，单位毫秒；范围 `1000`–`2147483647` |
| `timeoutMs` | integer | `15000` | 获取凭据后的请求取消计时，单位毫秒；范围 `100`–`300000` |

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

字段校验规则见 [shared/config/schema.ts](../../../shared/config/schema.ts)。
