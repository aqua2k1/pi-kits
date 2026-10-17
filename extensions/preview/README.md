# preview

`/preview` 选择当前会话分支的一轮回复进行只读预览，`Alt+P` 直接预览最新回复。

## 安装

```sh
pi install https://github.com/aqua2k1/pi-kits.git
```

## 快速开始

在已有回复且空闲的 Pi 交互式终端中输入，选择一轮回复后打开预览：

```text
/preview
/preview --thinking
/preview --help
```

| 参数 | 说明 |
|---|---|
| 无参数 | 选择回复，预览文本块 |
| `--thinking` | 加入模型思考块，每行加 Markdown 引用前缀 |
| `help`、`--help`、`-h` | 显示帮助；未知参数显示错误与帮助 |

一轮回复包括两条用户消息之间（或分支起止边界内）的所有助手消息，文本以空行拼接。
列表最新优先，编号从旧到新；标签取首个非空文本行，超过 50 个字符时截取并追加省略号。取消选择结束流程。
任务忙碌、尚无回复或所选内容为空时显示提示；预览要求 Pi 交互式终端。

直接打开最新一轮回复的文本块，在空闲时按下：

```text
Alt+P
```

预览用编辑器的 `-R` 参数打开临时 Markdown 文件，不回写会话；退出后清理临时文件，缺少编辑器或启动失败时显示错误。

## 配置

位置：`<agent-dir>/pi-kits.json`；修改后在 Pi 输入 `/reload` 生效。

| 键 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `preview.enabled` | boolean | `true` | 注册命令和快捷键 |
| `terminal.editor` | string | `"nvim"` | 编辑器可执行文件名或路径，含非空白字符；须接受 `-R` 参数 |

```json
{
  "preview": { "enabled": true },
  "terminal": { "editor": "<编辑器可执行文件>" }
}
```

将编辑器占位值替换为实际可执行文件；配置缺省时使用 `nvim`。

## 文档

- [共享配置与兼容规则](../../shared/config/README.md)
- [配置校验规则](../../pi-kits.schema.json)
