# 配置

配置位置：`<agent-dir>/pi-kits.json`，配置键 `commit`。目录解析、重载与兼容规则见[共享配置](../../../shared/config/README.md)。

| 键 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `enabled` | boolean | `true` | 控制命令、启动标志和会话事件处理器的注册 |
| `model` | string | 未设置 | 模型选择器的优先候选，标识形式为 `provider/model-id` |
| `lastModel` | string | 未设置 | 记忆的候选模型；选择模型后、生成前更新 |
| `thinking` | string | 未设置 | 传给生成子进程的 `--thinking` |
| `timeoutMs` | integer | `120000` | 生成子进程超时毫秒数 |
| `rememberModel` | boolean | `true` | 控制 `lastModel` 的读取和写入 |

## 示例

```json
{
  "commit": {
    "enabled": true,
    "model": "opencode-go/deepseek-v4-flash",
    "lastModel": "opencode-go/deepseek-v4-flash",
    "thinking": "high",
    "timeoutMs": 120000,
    "rememberModel": true
  }
}
```

字段的校验规则见 `shared/config/schema.ts`（[源码](../../../shared/config/schema.ts)）；导出的 JSON Schema 为 [pi-kits.schema.json](../../../pi-kits.schema.json)。
