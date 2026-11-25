# 配置

配置位置：`<cwd>/.pi/agent/pi-hide-prompts.json`，每轮开始前重新读取。文件或字段缺失时使用默认值；配置无效或读取失败时告警并保留原提示。

| 键 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `hideDocs` | boolean | `true` | `true` 用英文项目文档原则替换 Pi 文档指引，`false` 保留 Pi 默认指引；保留 `<docs>` 标签 |

## 示例

```json
{
  "hideDocs": false
}
```
