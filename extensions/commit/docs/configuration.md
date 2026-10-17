# 配置

配置位置：`<agent-dir>/pi-kits.json`，配置键 `commit`。目录解析、重载与兼容规则见[共享配置](../../../shared/config/README.md)。

| 键 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `enabled` | boolean | `true` | 控制命令、启动标志和会话事件处理器的注册 |
| `model` | string | 未设置 | 模型选择器的优先候选，标识形式为 `provider/model-id` |
| `lastModel` | string | 未设置 | 自动记忆的候选模型；选择模型后、生成前更新，示例省略此字段 |
| `thinking` | string | 未设置 | 非空字符串，传给生成子进程的 `--thinking` |
| `timeoutMs` | integer | `120000` | 生成超时毫秒数，范围 1000–2147483647 |
| `rememberModel` | boolean | `true` | 控制 `lastModel` 的读取和写入 |
| `notify.enabled`（顶层配置） | boolean | `true` | 生成完成通知的开关，见[通知配置](../../notify/README.md#配置) |

## 示例

```json
{
  "commit": {
    "enabled": true,
    "model": "<provider>/<model-id>",
    "thinking": "high",
    "timeoutMs": 120000,
    "rememberModel": true
  },
  "notify": {
    "enabled": true
  }
}
```

字段的校验规则见 [shared/config/schema.ts](../../../shared/config/schema.ts)。
