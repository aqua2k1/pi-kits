# 使用

## 任务结束通知

```text
请回复「完成」。
```

任务结束后，扩展在 TUI（Pi 交互式终端界面）空闲时安排通知；等待时间见[配置](configuration.md)。

通知标题固定为 `Pi`，正文取最后一条助手消息的结束状态：

| 结束状态 | 通知正文 |
|---|---|
| `error` | `Task failed.` |
| `aborted` | `Task aborted.` |
| `length` | `Response truncated (token limit).` |
| 其他或尚未记录 | `Task completed.` |

正文只包含状态。恢复成功的重试以最终助手消息为准，工具结果不改变记录的状态。

新输入、新任务开始、会话开始或关闭会取消待发通知；新的任务结束事件会替换待发计时器。发送前再次检查空闲状态。

通知传输与平台适配见[共享库](../../../shared/README.md)。
