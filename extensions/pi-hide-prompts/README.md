# pi-hide-prompts

隐藏系统提示中的 `<docs>...</docs>` 文档指引，默认隐藏。

## 安装

安装 pi-kits 后，通过 `pi config` 启用 `pi-hide-prompts`。

## 配置

在项目的 `.pi/agent/pi-hide-prompts.json` 中写入以下内容以显示文档指引：

```json
{
  "hideDocs": false
}
```

每轮开始前重新读取配置，下一轮生效。扩展不创建或修改配置文件。
配置无效时告警并保留原提示。

- [配置参考](docs/configuration.md)
