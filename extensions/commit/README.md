# commit

`/commit` 根据暂存区变更生成提交信息，经确认后创建 Git 提交。

## 安装

```sh
pi install https://github.com/aqua2k1/pi-kits.git
```

## 快速开始

在已有暂存变更的 Git 仓库中，于 Pi 交互界面输入：

```text
/commit
```

确认暂存文件，选择生成模型；审阅生成消息后选择「提交」创建提交。PATH 中需有 `git` 和 `pi`。

## 文档

- [使用](docs/usage.md)
- [配置](docs/configuration.md)
- [架构](docs/architecture.md)
