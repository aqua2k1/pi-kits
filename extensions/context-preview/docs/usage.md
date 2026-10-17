# 使用

## /context-preview

命令在终端交互界面中控制缓存并预览 payload（发送给模型 API 的原始请求体），实现见 [index.ts](../index.ts)。

```text
/context-preview start
/context-preview status
/context-preview
/context-preview stop
/context-preview help
```

| 参数 | 说明 |
|---|---|
| 无参数 | 将最近缓存的请求体格式化为 JSON 并交给编辑器预览 |
| `start` | 开始缓存后续 `before_provider_request` 事件的请求体 |
| `stop` | 停止缓存，保留上一次缓存供查看 |
| `status` | 显示缓存启用或禁用状态 |
| `help` | 显示命令帮助 |

缓存初始关闭，每次 `session_start` 事件都会关闭缓存并清空内容；开启缓存后的每次模型请求替换上一份缓存。尚无缓存时，预览内容为空；未知参数显示错误与帮助。

编辑器由[配置](configuration.md)指定，临时文件和只读启动机制见[共享预览实现](../../../shared/readonly-preview.ts)。入口对编辑器缺失或启动错误显示通知。
