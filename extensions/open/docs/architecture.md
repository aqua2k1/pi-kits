# 架构

[index.ts](../index.ts) 将命令和工具接入同一打开流程；目标解析与应用启动委托给[共享实现](../../../shared/desktop-open.ts)，工具展示使用[共享渲染器](../../../shared/docs/ui.md)。

## 文件地图

| 文件 | 职责 |
|---|---|
| [index.ts](../index.ts) | 配置开关、目标存在性检查、命令与工具注册 |
| [index.test.ts](../index.test.ts) | 配置对命令和工具注册的控制 |
| [package.json](../package.json) | 扩展入口、资源名和依赖 |

## 数据流

1. 扩展加载时读取[共享配置](../../../shared/config/README.md)，启用时注册命令和工具。
2. 命令参数或工具的 `target` 进入共用打开流程。
3. 流程处理空参数，再将目标与 `ctx.cwd` 传给共享解析器。
4. 本地目标经过存在性检查后，交给共享启动器；URL 直接交给启动器。
5. 命令显示通知，工具返回文本及结构化结果；操作形式见[使用](usage.md)。

## 约束

- 命令和工具共用打开流程，并传入各自上下文的 `ctx.cwd`，保证两种入口对相同目标使用一致的工作目录。
- `index.ts` 使用共享解析器和 URL 判定后再检查本地目标，避免将网址当作本地路径拒绝。
- 工具结果保留共享启动器的 `ok` 和 `message` 字段，供共享渲染器适配回调生成状态和预览文本。

## 测试

在仓库根目录执行：

```sh
node --import tsx --test extensions/open/index.test.ts
```

[index.test.ts](../index.test.ts) 覆盖默认启用、顶层开关与旧分组配置对命令和工具注册的影响；共享启动逻辑的测试见 [desktop-open.test.ts](../../../shared/desktop-open.test.ts)。
