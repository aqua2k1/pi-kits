# 使用

## 任务结束通知

在 Pi 交互式终端中输入任务，将占位值替换为回复文本：

```text
请回复「<完成文本>」。
```

任务结束且保持空闲后发送桌面通知，默认等待 1000 毫秒；标题固定为 `Pi`。
安装并配置下表对应的平台依赖后运行任务。

| 平台 | 前提与行为 |
|---|---|
| Linux | PATH 中有 `notify-send`，且接受 `--print-id` 和 `--replace-id` 参数；通过返回的通知编号替换上一条通知 |
| macOS | PATH 中有 `terminal-notifier`；`HOME` 为绝对路径，可创建及写入通知状态目录，状态目录为普通目录；通知按固定分组替换 |
| Windows | PATH 中有 `powershell.exe`，可使用 Windows 通知 API；开始菜单应用中存在标识包含 `WindowsTerminal` 或 `Terminal` 的已注册应用，通知归属该应用 |
| WSL | 使用 Windows 通知通道，具备上述 Windows 条件；通过 `WSL_DISTRO_NAME` 或 `WSL_INTEROP` 环境变量识别 |

Linux 请求 60 秒显示时长，macOS 在 60 秒后清除当前通知，Windows 设置一分钟过期时间。

## 通知正文

正文取最后一条助手消息的结束状态：

| 结束状态 | 通知正文 |
|---|---|
| `error` | `Task failed.` |
| `aborted` | `Task aborted.` |
| `length` | `Response truncated (token limit).` |
| 其他或尚未记录 | `Task completed.` |

正文只包含状态，恢复成功的重试以最终助手消息为准，工具结果不改变状态。

## 等待与取消

新输入、新任务开始、会话开始或关闭会取消待发通知；任务再次结束会重新计时。
发送前再次检查交互式终端模式和空闲状态；新任务开始前和会话起止时清空旧状态。
平台命令的输出被忽略，通知发送异常不打断任务流程。

## 相关文档

- [安装与配置](../README.md#配置)
