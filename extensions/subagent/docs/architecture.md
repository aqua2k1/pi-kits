# 架构

[入口](../index.ts)把工具调用交给管理器；管理器拥有任务轮次与队列，执行适配器拥有后端资源，终端适配器拥有 Herdr 终端与视图。展示层读取快照并订阅变化（[管理器](../manager.ts)、[执行接口](../runtime/index.ts)、[终端接口](../mux/index.ts)、[展示接口](../ui/presentation.ts)）。

## 文件地图

| 文件 | 职责 |
|---|---|
| [index.ts](../index.ts) | 配置启用检查、工具和命令注册、通知、会话退出清理 |
| [agents.ts](../agents.ts) | Markdown 定义发现、覆盖与通用元数据解析 |
| [manager.ts](../manager.ts) | 先入先出（FIFO）执行队列、轮次、结果、资源释放及视图布局 |
| [state.ts](../state.ts)、[policy.ts](../policy.ts) | 任务与后端状态分类、操作资格和展示判断 |
| [runtime/index.ts](../runtime/index.ts)、[runtime/errors.ts](../runtime/errors.ts) | 执行适配边界、统一事件及投递前拒绝错误 |
| [runtime/pi/config.ts](../runtime/pi/config.ts)、[index.ts](../runtime/pi/index.ts) | Pi 配置分区、进程启动、认证 TCP 控制连接 |
| [runtime/pi/worker.ts](../runtime/pi/worker.ts)、[protocol.ts](../runtime/pi/protocol.ts) | 子 Pi 扩展、逐行 JSON（JSONL）命令与事件协议 |
| [runtime/pi/clone.ts](../runtime/pi/clone.ts)、[extensions.ts](../runtime/pi/extensions.ts) | 父分支快照克隆与显式扩展解析 |
| [runtime/codex/config.ts](../runtime/codex/config.ts)、[schema.ts](../runtime/codex/schema.ts) | 会话选项、每轮审阅目标解析及工具 schema |
| [runtime/codex/index.ts](../runtime/codex/index.ts)、[transport.ts](../runtime/codex/transport.ts) | 私有 app-server、WebSocket RPC（远程过程调用）、原生事件映射与回复补读 |
| [runtime/codex/guardian.ts](../runtime/codex/guardian.ts)、[guardian.mjs](../runtime/codex/guardian.mjs) | POSIX 独立进程组及父进程通信断开后的清理 |
| [mux/index.ts](../mux/index.ts)、[herdr.ts](../mux/herdr.ts) | 终端与视图接口、Herdr 命令执行及资源身份检查 |
| [ui/presentation.ts](../ui/presentation.ts)、[renderers.ts](../ui/renderers.ts) | 统一标题、状态统计和工具结果展示 |
| [ui/status-widget.ts](../ui/status-widget.ts)、[views.ts](../ui/views.ts) | 状态区刷新、点击操作与视图管理面板 |
| [package.json](../package.json) | 显式扩展入口、资源名和测试脚本 |

共享配置、面板、树形列表和渲染组件分别见[配置服务](../../../shared/config/README.md)与[共享库](../../../shared/README.md)。

## 数据流

1. 入口根据配置与终端环境注册能力；首次操作惰性创建管理器和状态组件（[入口](../index.ts)、[注册测试](../index.test.ts)）。
2. 创建调用解析工作目录并从父目录加载 Agent 定义，管理器选择后端、解析配置并预检任务；Pi 在入队前冻结父分支（[管理器](../manager.ts)、[Pi 继承测试](../runtime/pi/inheritance.test.ts)）。
3. 队列取得执行槽后创建后端会话、等待启动，再向后端投递带轮次的任务（[管理器](../manager.ts)、[后端契约测试](../manager-runtime.test.ts)）。
4. Pi 通过认证 loopback TCP JSONL 上报事件，Codex 把私有 app-server 事件转换为统一事件；管理器更新快照和结果（[Pi](../runtime/pi/index.ts)、[Codex](../runtime/codex/index.ts)、[结果测试](../manager.test.ts)）。
5. 等待者取得所属轮次的快照；后台完成触发父会话后续消息，原生交互更新独立发布（[管理器](../manager.ts)、[通知测试](../index.test.ts)）。
6. 管理器按会话保留策略释放资源；视图变更串行执行；父会话退出清理拥有的后端、视图和状态组件（[管理器](../manager.ts)、[生命周期测试](../lifecycle.test.ts)）。

## 约束

- [包清单](../package.json)的父协调入口为 `index.ts`；Pi 后端显式加载 worker，worker 标记阻止递归注册，避免子进程继续创建协调器（[入口](../index.ts)、[Pi 启动](../runtime/pi/index.ts)、[注册测试](../index.test.ts)）。
- Agent 加载器保留原始执行配置，具体后端解析自身键并划分会话键与每轮键，以免通用层误判其他后端选项（[加载器测试](../agents.test.ts)、[分区测试](../manager-runtime.test.ts)）。
- 配置解析在资源创建前完成，任务解析同时用于预检与实际投递；解析保持幂等，避免自定义审阅指令重复追加（[Codex 解析](../runtime/codex/config.ts)、[重复解析测试](../runtime/codex/config.test.ts)）。
- 创建时的绝对工作目录沿管理器、后端和终端传递；Agent 查找仍使用父目录，避免切换任务目录改变所选定义（[入口测试](../index.test.ts)、[管理器测试](../manager-runtime.test.ts)、[Codex 测试](../runtime/codex/index.test.ts)）。
- 任务 `status` 与后端 `sessionState` 独立；操作策略读取真实完成、连接和清理事实，展示提示仅用于界面，避免把标题中的活动状态当成提交许可（[策略](../policy.ts)、[组合测试](../policy.test.ts)）。
- 续跑复用后端并进入同一队列，异步存活检查后再次检查连接和空闲状态，以免排队期间原生交互被任务接管（[管理器](../manager.ts)、[竞态测试](../manager-runtime.test.ts)）。
- 标准事件通过后端宿主回调交给管理器；后续轮次按 `round` 过滤旧事件，等待者绑定原轮次，避免旧完成、取消或投递失败影响新任务（[管理器](../manager.ts)、[轮次测试](../manager.test.ts)、[异步失败测试](../manager-runtime.test.ts)）。
- 原生回复更新独立于受管完成，结果按序发布且空回复保留已有内容；Codex 补读完成后复查交互身份，再发布回复和空闲状态，避免旧补读覆盖新结果或提前自动释放（[结果测试](../manager.test.ts)、[补读测试](../runtime/codex/index.test.ts)）。
- `RuntimeTaskRejectedError` 表示投递前拒绝、原生任务未受触碰；结果不明的发送错误使用普通错误路径，避免误保留仍在执行的后端（[错误定义](../runtime/errors.ts)、[拒绝测试](../runtime/codex/index.test.ts)、[管理器测试](../manager-runtime.test.ts)）。
- 管理器在启动前记录会话所有权，启动和附着失败后仍保留清理句柄；清理成功后才丢弃资源，失败保留重试与必要的执行槽，避免泄漏资源并超额执行（[管理器](../manager.ts)、[生命周期测试](../lifecycle.test.ts)）。
- 自动释放在串行操作中及视图探测后重新检查轮次和资格，以免旧检查关闭已续跑或进入原生交互的会话（[管理器](../manager.ts)、[释放竞态测试](../manager-runtime.test.ts)）。
- 视图布局由管理器决定，异步附着、探测和打开后复查权限；回滚只关闭本次新建视图，防止影响已有视图或其他任务（[管理器](../manager.ts)、[视图竞态测试](../manager-runtime.test.ts)）。
- Herdr 句柄限定创建它的适配器实例，销毁前确认窗格、终端与工作区身份及停止结果；部分启动失败用 `TerminalStartError` 交回句柄，避免误关外部终端或丢失清理责任（[终端接口](../mux/index.ts)、[身份与回滚测试](../mux/herdr.test.ts)）。
- Pi 分支克隆使用入队前快照，对克隆添加上下文编辑以隐藏未完成工具调用，保留原始历史，避免改动父会话或伪造工具结果（[克隆实现](../runtime/pi/clone.ts)、[测试](../runtime/pi/clone.test.ts)）。
- Pi worker 以整个批次的 `agent_settled` 作为完成边界；认证、帧解析或父连接失败触发关闭，避免中间重试结果被发布或孤立 worker 继续执行（[worker](../runtime/pi/worker.ts)、[协议与批次测试](../runtime/pi/worker.test.ts)）。
- Codex 后端、原生终端及认证临时目录归同一会话拥有；guardian 通过独立进程组清理后端子进程，关闭操作等待退出确认，避免父进程退出或终端脱离转移资源责任（[实现](../runtime/codex/index.ts)、[guardian 测试](../runtime/codex/guardian.test.ts)）。
- 展示组件订阅快照并在销毁时退订、停表；界面或通知回调失败不改变执行结果，避免展示故障中断任务或保留刷新资源（[状态组件](../ui/status-widget.ts)、[组件测试](../ui/components.test.ts)、[管理器](../manager.ts)）。

## 测试

在仓库根目录执行[包脚本](../package.json)：

```sh
npm test --workspace=pi-subagent
```

| 测试 | 覆盖模块 |
|---|---|
| [agents.test.ts](../agents.test.ts)、[runtime-config.test.ts](../runtime-config.test.ts) | 定义发现、覆盖、通用字段与后端配置分发 |
| [index.test.ts](../index.test.ts) | 启用条件、工具参数、目录、通知及命令 |
| [manager.test.ts](../manager.test.ts)、[manager-runtime.test.ts](../manager-runtime.test.ts)、[lifecycle.test.ts](../lifecycle.test.ts) | 队列、结果、轮次、注入后端、视图、释放、取消与清理 |
| [policy.test.ts](../policy.test.ts) | 操作许可、状态分类和展示组合 |
| [mux/herdr.test.ts](../mux/herdr.test.ts) | Herdr 身份、布局、回滚、清理确认与命令边界 |
| [Pi 配置](../runtime/pi/config.test.ts)、[启动](../runtime/pi/index.test.ts)、[扩展](../runtime/pi/extensions.test.ts) | 配置分区、CLI 参数和显式扩展解析 |
| [Pi 克隆](../runtime/pi/clone.test.ts)、[继承](../runtime/pi/inheritance.test.ts)、[worker](../runtime/pi/worker.test.ts) | 快照、上下文投影、JSONL、批次和原生交互 |
| [Codex 配置](../runtime/codex/config.test.ts)、[调用](../runtime/codex/call-config.test.ts)、[schema](../runtime/codex/schema.test.ts) | 会话参数、审阅目标与工具 schema |
| [Codex 执行](../runtime/codex/index.test.ts)、[传输](../runtime/codex/transport.test.ts)、[guardian](../runtime/codex/guardian.test.ts) | RPC、补读、轮次、认证、终端与进程组清理 |
| [组件](../ui/components.test.ts)、[渲染](../ui/renderers.test.ts)、[点击](../ui/status-widget-click.test.ts) | 状态区、面板交互、结果展示和鼠标行为 |

真实 Herdr 验证由[独立脚本](../tests/herdr-live.ts)显式启用，调用真实模型并创建终端资源：

```sh
PI_KITS_HERDR_LIVE=1 npm run test:herdr --workspace=pi-subagent
```

脚本的 `PI_KITS_CODEX_BIN` 可设为 `<Codex可执行文件绝对路径>`；通过后输出 `HERDR_LIVE_OK`（[脚本](../tests/herdr-live.ts)）。
