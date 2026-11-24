# pi-append-prompts

启动时按文件名顺序读取内置 Markdown 提示片段，并在每轮对话前追加到系统提示词末尾。

## 安装

```sh
pi install https://github.com/aqua2k1/pi-kits.git
```

## 快速开始

```sh
pi config
```

启用 `pi-append-prompts` 后直接对话，扩展自动将提示片段追加到现有系统提示词之后，不覆盖项目或全局的 `APPEND_SYSTEM.md`。在扩展的 `prompts/` 目录中增删 `.md` 文件后执行 `/reload` 生效。
