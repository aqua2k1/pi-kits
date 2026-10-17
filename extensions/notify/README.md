# notify

任务在 TUI（Pi 交互式终端界面）中结束并持续空闲后，发送桌面状态通知。

## 安装

```sh
pi install https://github.com/aqua2k1/pi-kits.git
```

仓库包通过 [Pi 清单](../../package.json)加载本扩展。

## 快速开始

在 Pi 交互式终端界面输入任务：

```text
请回复「完成」。
```

回复结束并保持空闲后，通知标题为 `Pi`，正文为 `Task completed.`。通知传输见[共享库](../../shared/README.md)。

## 文档

- [使用](docs/usage.md)
- [配置](docs/configuration.md)
- [架构](docs/architecture.md)
