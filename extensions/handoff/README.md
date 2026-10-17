# handoff

`/handoff` 从当前会话创建副本，并在副本中生成给下一位代理的交接摘要。

## 安装

```sh
pi install https://github.com/aqua2k1/pi-kits.git
```

仓库包通过 [Pi 清单](../../package.json)加载本扩展。

## 快速开始

在已有内容且已保存的 Pi 会话中输入：

```text
/handoff
```

命令等待当前任务空闲，创建副本并压缩，完成后显示交接会话路径；原会话保持原有内容。实现见 [index.ts](index.ts)。

## 文档

- [使用](docs/usage.md)
