# preview

`/preview` 选择当前会话分支的一轮回复进行只读预览，`Alt+P` 直接预览最新回复。

## 安装

```sh
pi install https://github.com/aqua2k1/pi-kits.git
```

仓库包通过 [Pi 清单](../../package.json)加载本扩展。

## 快速开始

在已有回复且空闲的 TUI（Pi 交互式终端界面）中输入：

```text
/preview
```

选择一轮回复后打开只读预览。编辑器设置见[配置](docs/configuration.md)，预览资源与终端交接见[共享库](../../shared/README.md)。

## 文档

- [使用](docs/usage.md)
- [配置](docs/configuration.md)
- [架构](docs/architecture.md)
