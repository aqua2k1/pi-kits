# 架构

[index.ts](../index.ts) 从当前会话分支整理回复并选择内容，交给[共享只读预览](../../../shared/readonly-preview.ts)；配置由[共享配置服务](../../../shared/config/README.md)读取。

## 文件地图

| 文件 | 职责 |
|---|---|
| [index.ts](../index.ts) | 参数解析、回复分组、文本提取、选择与预览调用 |
| [index.test.ts](../index.test.ts) | 配置对命令和快捷键注册的控制 |
| [package.json](../package.json) | 扩展入口、资源名和依赖 |

## 数据流

1. 扩展加载时读取配置，启用时注册命令与快捷键。
2. 命令解析参数，快捷键选择最新回复模式。
3. 预览入口检查空闲状态和 TUI 模式，读取当前分支。
4. 分组逻辑在用户消息处划分回复，收集助手消息；分组语义和选择顺序见[使用](usage.md)。
5. 提取所选回复正文，内容为空时显示提示。
6. 入口将正文、Markdown 扩展名和配置中的编辑器传给共享预览，并将启动失败结果转换为界面提示。

## 约束

- 分支分组以用户消息为边界，工具结果等条目不拆分回复，保证选择器与正文提取针对同一轮助手输出。
- 列表展示顺序反转时保留原标签到原记录的映射，避免最新优先展示导致预览错位。
- 命令和快捷键都传递共享配置中的 `terminal.editor`，保证两种入口使用相同编辑器；字段来源见[配置](configuration.md)。
- `index.ts` 只提取会话内容并调用共享预览，不自行管理临时资源，使清理由[共享实现](../../../shared/readonly-preview.ts)统一承担。

## 测试

在仓库根目录执行：

```sh
node --import tsx --test extensions/preview/index.test.ts
```

[index.test.ts](../index.test.ts) 覆盖默认启用、顶层开关与旧分组配置对命令和快捷键注册的影响；共享预览资源测试见 [readonly-preview.test.ts](../../../shared/readonly-preview.test.ts)。
