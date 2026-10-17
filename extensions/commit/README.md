# commit

`/commit` 根据暂存区变更生成提交信息，经确认后创建 Git 提交。

## 安装

```sh
pi install https://github.com/aqua2k1/pi-kits.git
```

仓库包通过 [Pi 清单](../../package.json)加载本扩展。

## 快速开始

在已有暂存变更的 Git 仓库中，于 Pi 交互界面输入：

```text
/commit
```

流程展示文件列表和模型选择，生成消息后进入审阅；选择「提交」创建提交。完整操作见[使用](docs/usage.md)。

## 文档

- [使用](docs/usage.md)
- [配置](docs/configuration.md)
- [架构](docs/architecture.md)
