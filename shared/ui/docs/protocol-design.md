# 通用 UI 协议设计草案

状态：场景盘点后的设计草案，不是冻结的 API。第一阶段已实现
`group/content/field/action`、视图快照与事件校验，见 [协议 API](protocol.md)。
进程内 session 与适配器契约已实现，见 [session API](session.md)。
Pi 基础对话顺序降级已实现，见 [Pi 对话适配器](pi-dialog.md)。
集合、host 和自定义 TUI/Web/GUI renderer 仍待实现。
目标见 [goals.md](goals.md)，架构边界见 [architecture.md](architecture.md)。

## 三层结构

```text
业务层：状态、校验、数据投影、语义事件处理
    ↓ 视图数据                     ↑ 事件
协议层：有限、可序列化的通用节点与交互契约
    ↓                             ↑
适配层：TUI / Pi-dialog / WebUI / GUI
```

协议不定义 questionnaire、stats、subagent 等业务类型。业务使用通用节点
组装界面，适配器不导入扩展 core、manager、工具 schema 或注册入口。
不同前端的渲染、布局、输入、事件路由与 UI 生命周期集中在 `shared/ui/`。

## 现有界面映射

路径均相对于仓库根目录。

| 界面 | 通用节点与必要变体 | 依据 |
| --- | --- | --- |
| 问卷逐题作答 | 分组、说明、单选/多选字段、文本字段、确认动作 | `extensions/ask-user-question/ui/component.ts` |
| 问卷 Review | 答案集合、缺答说明、改答/提交/取消动作 | `extensions/ask-user-question/ui/state.ts` |
| commit 模型选择 | 可筛选单选字段 | `extensions/commit/ui.ts` |
| commit 确认 | 文档、提交/重新生成/取消动作 | `extensions/commit/ui.ts` |
| stats | 汇总内容、模型集合、日期热力集合、选择与详情动作 | `extensions/stats/report.ts`、`tui.ts`、`template.html` |
| subagent widget / Views | 任务集合、状态内容、任务操作 | `extensions/subagent/ui/presentation.ts`、`views.ts` |
| provider-usage | 状态内容，支持刷新、陈旧与错误状态 | `extensions/provider-usage/index.ts` |
| preview / context-preview | 历史选择字段、Markdown/JSON 文档 | `extensions/preview/index.ts`、`extensions/context-preview/index.ts` |
| 工具卡片 | 摘要/详情内容，运行、错误、取消、截断状态 | `shared/ui/renderers.ts` |
| 通知 | 内容与严重程度，通过展示通道发送 | `extensions/notify/index.ts` |

subagent 当前没有面板内 transcript 浏览器；不要将未来的序列浏览需求
当作现有能力。stats 的 HTML 当前包含条形图与日热图，不能声称普通文本列表
即可保留全部现有展示能力。

## 最小节点集合

建议使用封闭的 TypeScript 判别联合，先不提供插件注册或自定义 renderer 回调。

| 节点 | 契约 | 有限变体 |
| --- | --- | --- |
| `group` | 有序子节点、可选标题与说明 | 初期仅语义分组，不规定 tabs/columns |
| `content` | 文本或文档内容、可选摘要、语义状态 | `text` / `markdown` / `json` |
| `field` | 标识、标签、当前值、只读/禁用、校验反馈 | `text` / `single` / `multiple`；选择字段可声明可筛选 |
| `collection` | 稳定条目标识、字段与层级、可选当前选择 | `list` / `table` / `tree`；后续验证 `bars` / `date-heatmap` |
| `action` | 标识、标签、是否可用、语义强调 | `default` / `primary` / `destructive` |

`field` 各变体的值类型应分别约束：文本为 string，单选为选项 ID 或 null，
多选为选项 ID 数组；不要将所有值都放进无限制的 JSON 对象。
选项身份不使用显示标签，保证重复标签仍能正确关联。

集合的表格列、树关系、条形数值和日期值应分别具有类型化的数据形状，
不采用 `Record<string, unknown>` 加 renderer 自行猜测。
`bars` 与 `date-heatmap` 需要统计界面的原型验证后再确定字段；
若它们塞入 collection 反而使联合复杂，可拆为独立通用节点。
第一阶段问卷与预览不依赖这些图形变体。

不提供 ANSI、CSS、坐标、终端行预算、具体快捷键、任意样式或业务专属节点。
节点协议与展示通道分离：面板、持久 widget、通知、工具卡片是宿主能力，
不通过节点里的 `kind: questionnaire` 或 `kind: subagent` 选择 renderer。
有限的展示提示必须由实际需求驱动，并明确支持或降级契约。

## 数据与事件

视图由稳定 view ID、递增 revision 和节点树组成。节点 ID 在一次视图生命周期
内唯一且稳定；同一节点更新不应无故丢失适配器的输入焦点和滚动位置。

最小事件形状示意：

```ts
type UIEvent =
  | { type: "change"; nodeId: string; value: string | null | string[] }
  // collection 实现时再加入 select 事件。
  | { type: "invoke"; nodeId: string }
  | { type: "dismiss" };
```

具体值必须按目标节点变体校验，而不仅按该示意联合校验。
远端消息另携带协议版本、会话 ID、view ID、revision 和事件 ID。
先使用完整快照更新，不在第一阶段实现通用 patch 引擎。

业务解释 action ID；UI 不解释“提交答案”或“停止任务”的业务意义。
invoke 前必须校验当前节点存在、动作仍可用及调用方权限，不能信任客户端
的 disabled 状态。过期事件不得误用到新界面；重连时发送最新快照，
不自动重放非幂等操作。具体去重和过期事件反馈需在远端实现阶段定案。

## 状态归属

- 业务拥有已确认答案、提交结果、统计数据、任务状态与操作规则。
- 未确认答案草稿若参与确认流程，由业务控制器维护；前端维护即时编辑缓冲，
  保证确认事件不会越过尚未交付的字段变化。草稿不等于已确认答案。
- 焦点、光标、IME 组合输入、滚动、hover、纯浏览折叠由适配器维护。
- 筛选、选中条目、当前步骤若影响业务动作或下一份视图数据，必须产生语义事件；
  仅影响本地浏览时可保留在适配器内。不以“是否属于 UI 状态”一概判断。
- 所有业务校验在业务层执行，协议仅携带校验反馈，适配器负责展示。

生命周期区分正常完成、用户关闭、外部中止、错误；关闭只结算一次并解除订阅。
创建、客户端已挂载和已关闭是不同事件。业务最终结果不塞进通用 UI 结果联合，
由业务控制器完成自己的 Promise 或用例。

## 能力与安全边界

协议模型可序列化且不携带函数、AbortSignal、Pi context、文件句柄或凭据。
进程内 controller/source 的函数接口与远端 wire 消息分开。

Pi-dialog 是能力有限的适配器，不承诺支持任意节点树；复杂组合必须有明确的
顺序对话降级或报告不支持。业务不按前端分支，能力选择集中于共享 host。

不得默认把 context-preview 的原始 provider payload、thinking、完整任务快照、
后端路径或认证信息广播给客户端。业务负责最小数据投影与访问授权，
远端适配负责连接绑定和边界校验。内容格式不意味着可执行脚本，浏览器
Markdown/HTML 展示需要安全渲染；折叠预览不是脱敏措施。
本机编辑器、浏览器打开和桌面通知不能默默改成远端客户端操作。

## 模块与实施顺序

```text
shared/ui/
  protocol/       # 节点、视图、事件、校验；不依赖 Pi/TUI/Node
  session/        # 快照更新、事件路由、取消与清理
  adapters/       # tui、pi-dialog；remote 按需增加
  clients/        # web/gui 按需增加，不预建空实现
  host.ts         # 会话级宿主绑定、展示通道与能力选择
  docs/
```

1. 先确定 group/content/field/action 的类型与校验，测试纯协议导入和序列化。
2. 用问卷与只读预览验证控制器、快照更新与 TUI/Pi-dialog 适配边界。
3. 保留公开兼容导出，逐步将终端组件迁入共享适配层。
4. 用任务列表验证 collection，再用 stats 决定表格与图形变体。
5. 按需求实现远端传输与 renderer，测试断连、过期事件和授权。

新增公开子路径需显式声明在 `shared/package.json`；协议导出不能通过 barrel
加载终端依赖。新增子目录测试需同步测试发现规则，当前 shared 测试 glob
仅覆盖 `ui/*.test.ts`。迁移期间保持已有问卷结果、重复标签、多选、部分取消、
中止清理与 TUI 紧凑布局测试。
