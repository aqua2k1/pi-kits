# 架构

[index.ts](../index.ts) 编排交互提交流程，[ui.ts](../ui.ts) 提供对话框，[core.ts](../core.ts) 负责 Git、生成子进程和模型记忆。配置服务由 [@pi-kits/config](../../../shared/config/README.md) 提供，通知调用[共享库](../../../shared/README.md)。

## 文件地图

| 文件 | 职责 |
|---|---|
| `index.ts` | 注册命令、标志与事件，协调生成、审阅和提交 |
| `core.ts` | 暂存区读取、任务构造、子进程参数与执行、输出清理、模型记忆 |
| `ui.ts` | TUI 模糊搜索、消息预览和操作选择；RPC 选择框 |
| `package.json` | 扩展入口、资源名、依赖与测试脚本 |
| `core.test.ts` | 核心逻辑及 Git、子进程、配置读写测试 |
| `index.test.ts` | 注册、启动派发及命令流程测试 |

## 数据流

1. 扩展工厂读取配置，启用时注册入口；启动触发行为见[使用](usage.md#pi---commit)。
2. 命令读取暂存文件列表并请求确认。
3. UI 返回所选模型，按[配置](configuration.md)处理模型记忆。
4. 核心逻辑将文件列表和最新暂存区 diff 经 stdin 传入 `pi -p`；生成规则通过系统提示词传入。
5. 流程清理输出的包裹代码围栏并检查空结果，再显示消息审阅界面。
6. 用户操作决定重新生成、结束流程或执行 Git 提交；操作语义见[使用](usage.md#commit)。

## 约束

- `core.ts` 的 Git 与生成逻辑通过参数接收工作目录，`index.ts` 始终传入 `ctx.cwd`。
- 生成规则集中在 `COMMIT_SYSTEM_PROMPT`；`buildTask` 只携带文件列表与 diff。
- `buildPiArgs` 为子进程设置 `--no-tools`、`--no-extensions`、`--no-skills`、`--no-context-files` 和 `--no-session`，隔离生成环境。
- `index.ts` 将配置或记忆候选的存在性传给 `chooseModel`；`orderModelOptions` 据此补入注册表缺失的候选。
- 模型记忆通过共享配置 API 更新顶层 `commit.lastModel`；共享读写约定见[配置兼容与更新](../../../shared/config/docs/configuration.md)。
- 审阅 UI 返回操作值，`index.ts` 持有完整消息并传给 `gitCommit`，展示截断不改变提交内容。

## 测试

在仓库根目录执行：

```sh
npm test --workspace=pi-commit
```

- `core.test.ts`：暂存状态解析、Git 往返、任务与参数构造、生成成功/失败/超时、围栏清理、模型排序和记忆读写。
- `index.test.ts`：命令与标志注册、启动条件、禁用配置、交互前提、模型优先级、记忆开关、thinking 与超时传递、完成通知开关。
