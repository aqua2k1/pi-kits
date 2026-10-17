# ask-user-question

`ask_user_question` 让模型向用户收集单选、多选和自定义回答，返回结构化问卷结果。

## 安装

```sh
pi install https://github.com/aqua2k1/pi-kits.git
```

仓库包通过 [Pi 清单](../../package.json)加载本扩展。

## 快速开始

在 Pi 终端交互界面向模型发送：

```text
请使用 ask_user_question 询问我选择哪个方案，提供“<方案甲>”和“<方案乙>”。
```

模型调用工具后显示问卷；确认答案并在 Submit 页提交。操作见[使用](docs/usage.md)。

## 文档

- [使用](docs/usage.md)
- [配置](docs/configuration.md)
- [架构](docs/architecture.md)
