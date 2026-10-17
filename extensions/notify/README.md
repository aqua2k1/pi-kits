# notify

任务在 Pi 交互式终端中结束并持续空闲后，发送桌面状态通知。

## 安装

```sh
pi install https://github.com/aqua2k1/pi-kits.git
```

## 快速开始

在 Pi 交互式终端中输入任务，将占位值替换为回复文本：

```text
请回复「<完成文本>」。
```

回复结束并保持空闲，默认等待 1000 毫秒后发送通知；标题为 `Pi`。

## 运行前提与通知

运行前准备对应平台的依赖：

| 平台 | 前提 |
|---|---|
| Linux | PATH 中有接受 `--print-id`、`--replace-id` 的 `notify-send` |
| macOS | PATH 中有 `terminal-notifier`；`HOME` 为绝对路径，通知状态目录可创建、可写且为普通目录 |
| Windows、WSL | PATH 中有 `powershell.exe`，可使用 Windows 通知 API；开始菜单有标识含 `WindowsTerminal` 或 `Terminal` 的已注册应用 |

正文只包含最后一条助手消息的完成、失败、中止或截断状态，工具结果不改变状态。
新输入、新任务开始、会话开始或关闭会取消待发通知；任务再次结束会重新计时，发送前复查交互式终端模式和空闲状态。通知发送异常不打断任务。
通知通过[共享库](../../shared/README.md)发送到桌面。

## 配置

位置：`<agent-dir>/pi-kits.json`；修改后在 Pi 输入 `/reload` 生效。

| 键 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `notify.enabled` | boolean | `true` | 注册任务通知事件处理器 |
| `notify.quietPeriodMs` | integer | `1000` | 任务结束后的空闲等待毫秒数，范围 `0`–`60000` |

```json
{
  "notify": {
    "enabled": true,
    "quietPeriodMs": 1000
  }
}
```

## 文档

- [使用与平台前提](docs/usage.md)
- [共享配置与兼容规则](../../shared/config/README.md)
- [配置校验规则](../../pi-kits.schema.json)
