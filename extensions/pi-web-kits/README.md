# pi-web-kits

`web_search` 按必填 `source` 搜索网页或 GitHub；网页使用 SearXNG 或 Codex，GitHub 使用本地 `gh api`。`web_fetch` 获取网页与 GitHub 仓库内容并保存为本地文本。两个工具归于 `pi-web-kits` namespace，工具名称不变。

## 安装

```sh
pi install https://github.com/aqua2k1/pi-kits.git
```

仓库包安装后加载本扩展。

## 快速开始

在 Pi 中输入：

```text
/pi-web-kits status
```

命令显示网页／GitHub 搜索能力开关、网页路由来源、抓取和认证状态。`/pi-web-kits test github` 使用固定仓库查询检查 GitHub 连接。默认使用 `http://localhost:8080` 的 SearXNG；使用其他地址时，在启动 Pi 前设置 `SEARXNG_URL`。连接测试与工具调用见[使用](docs/usage.md)，完整设置见[配置](docs/configuration.md)。

## 文档

- [使用](docs/usage.md)
- [配置](docs/configuration.md)
- [架构](docs/architecture.md)
