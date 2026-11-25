# pi-hide-prompts

默认将系统提示中的 Pi 文档指引替换为简短的项目文档原则，保留 `<docs>...</docs>` 结构。

## 安装

安装 pi-kits 后，通过 `pi config` 启用 `pi-hide-prompts`。

## 配置

在项目的 `.pi/agent/pi-hide-prompts.json` 中写入以下内容以保留 Pi 默认文档指引：

```json
{
  "hideDocs": false
}
```

默认原则：以当前项目的文档和实现为依据；遇到不确定的接口或约定时，先查阅相关文档再修改。提示内容使用英文，通过结构化 section 写入请求与 session。

每轮开始前重新读取配置，下一轮生效。扩展不创建或修改配置文件。
配置无效时告警并保留原提示。

- [配置参考](docs/configuration.md)
