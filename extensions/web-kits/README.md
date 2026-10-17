# web-kits

`web_search` 通过 SearXNG 或 Codex 搜索，`web_fetch` 获取网页与 GitHub 仓库内容并保存为本地文本。

## 安装

```sh
pi install https://github.com/aqua2k1/pi-kits.git
```

仓库包通过 [Pi 清单](../../package.json)加载本扩展，扩展入口见[包清单](package.json)。

## 快速开始

在 Pi 中输入：

```text
/web-tools status
```

命令显示搜索、抓取和认证配置状态；连接测试及工具调用见[使用](docs/usage.md)。

## 文档

- [使用](docs/usage.md)
- [配置](docs/configuration.md)
- [架构](docs/architecture.md)
