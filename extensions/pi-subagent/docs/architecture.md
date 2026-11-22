# 架构

入口解析工具调用和 Agent 定义，管理器拥有队列、受管轮次与资源释放，后端拥有执行资源和原生会话，Herdr 适配器拥有终端及各自的视图放置策略。展示层订阅快照；共享配置负责校验及默认化，共享 UI 提供面板、树和渲染组件。

## 模块关系

```mermaid
flowchart LR
  entry["index.ts<br/>注册与父会话通知"] --> agents["agents.ts<br/>命名定义"]
  entry --> manager["manager.ts<br/>队列、轮次与资源编排"]
  entry --> ui["ui/<br/>状态区、面板和工具卡片"]
  ui --> manager
  manager --> policy["policy.ts、state.ts<br/>状态与操作资格"]
  manager --> pi["runtime/pi/<br/>Pi 执行及上下文克隆"]
  manager --> codex["runtime/codex/<br/>Codex 执行及进程组清理"]
  manager --> mux["mux/<br/>Herdr 终端和视图"]
  pi --> mux
  codex --> mux
```

后端通过 `runtime/index.ts` 的契约向管理器发布统一事件，管理器与展示层共用状态策略。

## 文件地图

以下路径相对扩展目录；仅列源码。

| 文件 | 职责 |
|---|---|
| `index.ts` | 启用条件、工具与命令、父会话通知、退出清理 |
| `agents.ts` | Markdown 定义发现、同名覆盖、通用元数据解析 |
| `manager.ts` | FIFO 队列、轮次、等待者、结果、视图句柄与资源释放 |
| `state.ts`、`policy.ts` | 独立状态轴、操作资格与展示提示 |
| `util.ts` | 异步操作串行链与 UTF-8 字节截断 |
| `runtime/index.ts` | 后端契约、共享协议上限、强类型事件联合与投递前拒绝错误 |
| `runtime/pi/config.ts` | Pi 会话配置分区及任务解析 |
| `runtime/pi/index.ts` | Pi 启动、认证 loopback TCP、终端资源与提示词文件 |
| `runtime/pi/worker.ts` | 子 Pi 通信桥、JSONL 命令与批次结束边界 |
| `runtime/pi/clone.ts` | 父分支快照和独立会话克隆 |
| `runtime/pi/extensions.ts` | 扩展源解析和包声明资源选择 |
| `runtime/codex/config.ts` | 会话开关、每轮审阅目标和工具参数结构 |
| `runtime/codex/index.ts` | 私有 app-server、线程控制、事件转换与回复补读 |
| `runtime/codex/transport.ts` | Bearer WebSocket 连接、JSON-RPC 请求关联、超时与审批策略 |
| `runtime/codex/guardian.ts`、`runtime/codex/guardian.mjs` | POSIX 进程组、父进程 IPC 与后端清理 |
| `mux/index.ts` | `MuxAdapter` 终端和视图契约 |
| `mux/resolve.ts` | 按显式优先级根据环境变量选择 `herdr-app` 或 `herdr` |
| `mux/herdr-app.ts`、`mux/herdr.ts` | 新版通过 `hc` 请求标签页，旧版通过 Herdr CLI 维护右分屏与纵向堆叠 |
| `ui/presentation.ts`、`ui/renderers.ts` | 统一身份标题、统计、工具结果和通知展示 |
| `ui/status-widget.ts`、`ui/views.ts` | 状态刷新、点击和视图面板 |

## 数据流

```mermaid
sequenceDiagram
  participant Parent as 父会话工具调用
  participant Entry as index.ts
  participant Definitions as agents.ts
  participant Manager as manager.ts
  participant Runtime as Pi 或 Codex 后端
  participant Herdr as Herdr 适配器
  participant UI as 展示层
  Parent->>Entry: 任务、目录与调用配置
  Entry->>Definitions: 从父工作目录查找命名定义
  Definitions-->>Entry: 定义及角色正文
  Entry->>Manager: 创建任务
  Manager->>Runtime: 解析配置、预检并冻结输入
  Manager-->>Parent: 任务快照和完整 ID
  Manager->>Runtime: 队列取得执行槽后启动并投递轮次
  Runtime->>Herdr: 按需创建原生终端
  Runtime-->>Manager: 状态、统计与已结束回复
  Manager-->>UI: 快照变化
  Manager-->>Entry: 未被等待者接收的完成结果
  Entry-->>Parent: 后续消息
  Manager->>Runtime: 满足释放条件时关闭资源
```

前台调用等待所属轮次；续跑复用后端并进入同一队列；原生交互更新只加入父上下文；投递前拒绝结束本轮，连接或投递结果不明时进入清理路径。

## 约束

- 六个工具共享与扩展目录同名的 `pi-subagent` namespace 元数据，保持 Codemode 分组与发现入口一致；工具名称、参数和默认 direct 暴露保持不变。
- `index.ts` 在 worker 标记为 `1` 时直接返回；Pi 后端显式加载通信桥，防止子 Pi 递归注册父协调工具。
- `mux/resolve.ts` 显式优先匹配非空 `HC_TERMINAL_ID`（`herdr-app`），其次匹配 `HERDR_ENV === "1"`（`herdr`），均未匹配时不注册扩展，防止无感环境误启用或双环境优先级漂移。
- 视图放置策略归各 mux 适配器自有：`MuxAdapter.open_view` 只接收终端句柄，管理器不探测其他任务的视图，防止新版异步标签页处于未确认态时阻塞无关任务开视图。
- 新版 `herdr-app` 仅通过 `hc` 读取父终端的 `herdr.space`，用独立 `herdr.tab` 和 `terminal.keep` 请求标签页，防止假定 app 与任务同机；焦点属于客户端本地状态，聚焦操作提示手动切换。
- 新版视图通过 `doc.get` 的 `herdr-app` 共享布局核对附着；请求未确认时探测报错而非声明存活或触发释放。关闭先清理所属标签及 keep，再以版本化 `doc.set` 只移除本任务窗格，冲突重读并保留其他窗格和未知字段，防止误关任务或覆盖客户端变更。
- 新版终端以随机所有权标签和父终端核对身份；启动响应丢失时保留唯一名称及清理句柄，销毁确认退出后再移除记录，防止误杀外部终端或丢失清理责任。
- 旧版 `herdr` 自主维护父工作区内首视图向右、后续视图向最后存活视图向下分屏的列布局；句柄仅属于创建它的适配器实例，销毁前核对窗格、终端、工作区及停止结果，部分启动失败交回清理句柄，防止误关外部终端或丢失所有权。
- `agents.ts` 只解析通用字段，保留原始 `runtime_config`；后端划分会话键和每轮键，Pi 专属选项（`extensionAllowlist`、`workerPath`）由 `createPiRuntime` 工厂参数持有，防止通用契约和管理器泄漏后端细节。
- 管理器在入队前完成配置、任务和大小预检并缓存已解析命令；后端发送入口保持任务解析幂等，防止自定义审阅要求重复追加。
- 绝对 `cwd` 沿入口、管理器、后端和终端传递，Agent 查找仍取父目录，防止任务目录切换改变定义来源。
- `status` 与 `sessionState` 独立，操作资格读取实际完成、连接和清理事实，防止展示提示被当作投递许可。
- 续跑复用后端，异步存活检查后再次检查连接及空闲状态，防止排队期间开始的原生交互被接管。
- 第二轮起按 `round` 过滤旧任务事件，等待者绑定原轮次，防止旧完成、取消或发送失败修改新轮次。
- 结果发布按交互序号过滤，空回复保留已有结果；Codex 补读后复查身份并在发布后报告空闲，防止旧回复覆盖新回复或资源提前释放。
- `RuntimeTaskRejectedError` 只表示原生任务未受触碰的投递前拒绝；发送结果不明使用普通错误路径，防止保留仍执行任务的失联后端。
- 管理器在启动前记录后端所有权，清理确认成功后才丢弃句柄；清理失败保留重试责任及必要的执行槽，防止资源泄漏和超额执行。
- 自动释放在串行操作中及视图探测后重查轮次和资格，防止旧检查关闭已续跑或正在原生交互的会话。
- 管理器串行执行视图打开、关闭与释放，打开后重查权限，回滚只关闭本次新建视图，防止影响已有视图和其他任务。
- Pi 入队前冻结父分支，只在克隆的上下文投影中隐藏未完成工具调用，保留原始历史，防止修改父会话或伪造工具结果。
- Pi worker 以 `agent_settled` 作为整批完成边界，父连接或协议失败触发关闭，防止重试中间结果被当作完成或孤立 worker 继续执行。
- Codex WebSocket 传输在连接打开时同步安装消息处理器并仅通过 Bearer 请求头认证，托管阻塞请求在无原生终端接管时拒绝，防止丢失首批事件或泄漏令牌。
- Codex 后端、原生终端和认证目录归同一会话拥有，guardian 关闭等待退出确认，防止终端脱离或父进程退出遗留执行资源。
- 包资源名从 `extensionResources` 读取并限于启用的 Pi 清单路径，防止名称猜测或路径越界加载扩展。
- 展示组件销毁时退订并停表，展示和通知回调失败不改执行结果，防止 UI 故障中断任务或遗留刷新资源。

## 测试

在仓库根目录执行：

```sh
npm test --workspace=pi-subagent
```

| 测试文件 | 覆盖模块和行为 |
|---|---|
| `agents.test.ts`、`runtime-config.test.ts` | 定义覆盖、通用元数据、后端选项分发 |
| `index.test.ts` | 注册条件、工具参数、目录、通知与命令 |
| `manager.test.ts`、`manager-runtime.test.ts`、`lifecycle.test.ts` | 队列、轮次、等待、结果、视图、释放、竞态与清理重试 |
| `policy.test.ts` | 状态组合、操作资格与展示提示 |
| `mux/resolve.test.ts` | 显式环境优先级、环境固定与工厂隔离 |
| `mux/herdr-app.test.ts` | 新版 RPC、终端所有权、清理、远端标签页请求、异步附着、布局 CAS 及焦点提示 |
| `mux/herdr.test.ts` | 旧版 CLI 边界、列布局、身份核对、回滚与停止确认 |
| `runtime/pi/config.test.ts`、`runtime/pi/index.test.ts`、`runtime/pi/extensions.test.ts` | 配置、启动参数与扩展资源解析 |
| `runtime/pi/clone.test.ts`、`runtime/pi/inheritance.test.ts`、`runtime/pi/worker.test.ts` | 快照、上下文投影、协议、批次、原生交互 |
| `runtime/codex/config.test.ts`、`runtime/codex/call-config.test.ts` | 开关、每轮审阅目标和参数结构 |
| `runtime/codex/index.test.ts`、`runtime/codex/transport.test.ts`、`runtime/codex/guardian.test.ts` | 补读、WebSocket JSON-RPC 与认证、审批策略、轮次、终端和进程组清理 |
| `ui/components.test.ts`、`ui/renderers.test.ts`、`ui/status-widget-click.test.ts` | 状态区、面板、结果展示和鼠标行为 |

`tests/herdr-live.ts` 需要显式启用，会调用真实模型并创建 Herdr 资源；其环境变量 `PI_KITS_CODEX_BIN` 可指定 `<Codex可执行文件绝对路径>`：

```sh
PI_KITS_HERDR_LIVE=1 npm run test:herdr --workspace=pi-subagent
```

## 相关文档

- [配置及校验 schema](configuration.md)
- [共享配置](../../../shared/config/README.md)
- [共享 UI](../../../shared/README.md)
