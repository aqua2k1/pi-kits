# context-preview

`/context-preview` 缓存并只读查看最近一次模型请求的原始请求体。

## 安装

```sh
pi install https://github.com/aqua2k1/pi-kits.git
```

## 快速开始

在 Pi 交互式终端中启用缓存，发送一条消息后查看请求：

```text
/context-preview start
```

发送消息、模型请求发出后输入：

```text
/context-preview
/context-preview status
/context-preview stop
/context-preview help
```

| 参数 | 说明 |
|---|---|
| 无参数 | 将最新缓存格式化为 JSON 并预览；尚无缓存时内容为空 |
| `start` | 开始缓存后续模型请求，每次请求替换上一份缓存 |
| `stop` | 停止缓存，保留上一份缓存供查看 |
| `status` | 显示缓存启用或禁用状态 |
| `help` | 显示帮助；未知参数显示错误与帮助 |

缓存初始关闭；每次会话开始都关闭缓存并清空内容。命令要求 Pi 交互式终端。
预览用编辑器的 `-R` 参数打开临时 JSON 文件，不回写会话，编辑器退出后清理临时文件；缺少编辑器或启动失败时显示错误。

## 配置

位置：`<agent-dir>/pi-kits.json`；修改后在 Pi 输入 `/reload` 生效。

| 键 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `contextPreview.enabled` | boolean | `true` | 注册命令及缓存事件；运行时缓存仍需 `start` 开启 |
| `terminal.editor` | string | `"nvim"` | 编辑器可执行文件名或路径，含非空白字符；须接受 `-R` 参数 |

```json
{
  "contextPreview": { "enabled": true },
  "terminal": { "editor": "<编辑器可执行文件>" }
}
```

将编辑器占位值替换为实际可执行文件；配置缺省时使用 `nvim`。

## 文档

- [共享配置与兼容规则](../../shared/config/README.md)
- [配置校验规则](../../pi-kits.schema.json)
