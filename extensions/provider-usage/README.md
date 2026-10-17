# provider-usage

`/usage` 刷新当前主会话模型对应的 DeepSeek 账户余额或 ChatGPT 套餐用量，在编辑器下方展示（[实现](index.ts)）。

## 安装

```sh
pi install https://github.com/aqua2k1/pi-kits.git
```

仓库包通过 [Pi 清单](../../package.json)加载本扩展。

## 快速开始

在 Pi 中选择已配置认证的 `deepseek` 或 `openai-codex` 服务商模型后输入：

```text
/usage
```

组件刷新并通知当前显示结果；认证读取自 Pi 模型注册表（[入口](index.ts)）。

## 文档

- [使用](docs/usage.md)
- [配置](docs/configuration.md)
- [架构](docs/architecture.md)
