# 配置

配置位置：`<cwd>/.pi/agent/pi-hide-prompts.json`，每轮开始前重新读取。文件或字段缺失时使用默认值；配置无效或读取失败时告警并保留原提示。

| 键 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `hideDocs` | boolean | `true` | `true` 隐藏 `<docs>...</docs>`，`false` 显示 |

## 示例

```json
{
  "hideDocs": false
}
```
