# context-preview

`/context-preview` 缓存并查看最近一次模型请求的原始请求体。

## 安装

```sh
pi install https://github.com/aqua2k1/pi-kits.git
```

仓库包通过 [Pi 清单](../../package.json)加载本扩展。

## 快速开始

在 Pi 终端交互界面输入：

```text
/context-preview start
```

发送一条消息，等待模型请求发出后输入：

```text
/context-preview
```

命令将最新缓存交给编辑器预览；编辑器设置见[配置](docs/configuration.md)。

## 文档

- [使用](docs/usage.md)
- [配置](docs/configuration.md)
