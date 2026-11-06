# web-kits

`web_search` 通过 SearXNG 或 Codex 搜索，`web_fetch` 获取网页与 GitHub 仓库内容并保存为本地文本。

## 安装

```sh
pi install https://github.com/aqua2k1/pi-kits.git
```

仓库包安装后加载本扩展。

## 快速开始

在 Pi 中输入：

```text
/web-tools status
```

命令显示搜索、抓取和认证配置状态。默认使用 `http://localhost:8080` 的 SearXNG；使用其他地址时，在启动 Pi 前设置 `SEARXNG_URL`。连接测试与工具调用见[使用](docs/usage.md)，完整设置见[配置](docs/configuration.md)。

## 文档

- [使用](docs/usage.md)
- [配置](docs/configuration.md)
- [架构](docs/architecture.md)
