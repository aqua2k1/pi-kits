# open

`/open` 和模型工具 `open` 用系统默认应用打开文件、网址或目录。

## 安装

```sh
pi install https://github.com/aqua2k1/pi-kits.git
```

## 快速开始

```text
/open <文件路径>
/open <网址>
/open <目录路径>
```

将占位值替换为实际目标。命令显示启动结果：成功为信息提示，失败为警告。

| 参数 | 说明 |
|---|---|
| 目标 | 必填，文件路径、网址或目录路径；空参数显示用法 |

相对路径基于当前工作目录，`~` 表示主目录，目标开头的 `@` 会被移除。
本地目标不存在时显示目标路径；成功表示系统打开程序已启动。

## open 工具

模型调用 `open` 时传入：

```json
{ "target": "<文件路径、网址或目录路径>" }
```

| 参数 | 说明 |
|---|---|
| `target` | 必填 string，文件路径、网址或目录路径 |

将占位值替换为实际目标。工具采用与命令相同的路径解析和存在性检查，返回文本结果及包含 `ok`、`message` 的 `details`，展示 `opened` 或 `error` 状态。

## 配置

位置：`<agent-dir>/pi-kits.json`；修改后在 Pi 输入 `/reload` 生效。

| 键 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `open.enabled` | boolean | `true` | 注册命令和工具 |

```json
{
  "open": { "enabled": true }
}
```

## 文档

- [共享配置与兼容规则](../../shared/config/README.md)
- [配置校验规则](../../pi-kits.schema.json)
