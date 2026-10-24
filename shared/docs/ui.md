# 共享 UI

## Shared terminal UI

Reusable UI lives in `shared/ui/`, independently of the tool schema and
extension registration:

- `@pi-kits/shared/ui/tabs`: `layoutTabs(labels, active, width)` and `tabAt`
  provide a bounded tab viewport and component-local mouse hit testing.
- `@pi-kits/shared/ui/panel`: `fillPanel` and `panelRule` provide opaque
  padded frames, pinned footer rows, and width-safe rules.
- `@pi-kits/shared/ui/tree`: `renderTree(nodes, theme, width)` renders flat or
  nested `TreeNode<T>` lists independently of widget frames. Each node supplies
  single-line, optionally themed `content`, optional `children` and caller-owned
  `data`. Connectors use `muted`; last-sibling/ancestor state determines `├─`,
  `└─`, `│` and four-column indentation. The shared module exports
  `TREE_BRANCH_MARKER`, `TREE_LAST_BRANCH_MARKER`, `TREE_CONTINUATION_MARKER`,
  `TREE_DETAIL_MARKER` and `TREE_INDENT_WIDTH`; business renderers do not hardcode
  these glyphs or indentation. Optional `marker` supports detail rows using
  `TREE_DETAIL_MARKER` (`⎿`) without changing ancestor continuation. Output rows retain `text`,
  `depth` and each node's own `data` (never inherited), so callers can map rows
  to actions. Content is clipped by terminal width; callers own row budgets and
  input handling. Compose the rows with a widget frame, or use them on their own.
- `@pi-kits/shared/ui/widget`: `renderWidgetFrame(title, theme, width, renderBody)`
  provides a rounded `dim` border, an `accent` title and one-column padding.
  The callback receives the available content width; ANSI/Unicode lines are
  clipped and padded to the full frame width. Below 24 columns it falls back to
  an unbordered heading and body; empty content renders nothing. Callers own
  height limits, content styling, subscriptions and timers.
  `widgetContentBounds(width)` supplies the content rectangle (excluding the
  heading, border and padding) for caller-owned mouse hit testing.
- `@pi-kits/shared/ui/docked-panel`: the fixed half-screen editor-dock design:
  `layout.ts` owns height, compact thresholds, title/detail/list budgeting and
  scrolling windows; `frame.ts` owns the themed titled top boundary, separate
  navigation row, uninterrupted bottom boundary, standalone muted shortcut row,
  compact content priorities, padding, and pinned control hit rectangles.
  `session.ts` owns non-overlay `ui.custom`, abort completion, listener removal,
  and exactly-once component disposal across host and fallback cleanup.
  `events.ts` defines optional opened/closed callbacks and adapter event payloads.

These modules do not register tools, commands, or lifecycle handlers. This is a
small fixed design for the questionnaire's needs, not a configurable UI framework.
Tabs disappear below seven panel rows, shortcuts below nine. Six-row review keeps
its title, answer and two controls; tiny panels underline their last row instead
of sacrificing the title or active input to a bottom rule.

Questionnaire data, state transitions, keys, question/option text, tab labels,
review/confirmation, and custom `Input` focus/IME handling remain in
`extensions/ask-user-question/ui/`. `tui.ts` adapts those to the shared session;
`index.ts` wires callbacks to `pi.events`. `core.ts` owns schemas, answer types,
answer construction and native non-TUI dialogs. UI depends on the business core
and shared design primitives, not the other way around. Shared files are library
exports only, never Pi extension manifest entries.

## 共享信息行

共享 UI 管理编辑器下方的自动排版 widget。当前两个组件在宽度充足时显示为：

```text
[provider-usage：余额或套餐用量]       [token-meter：TTFT 与 TPS]
```

| 内容标识 | 优先级 | 空串行为 |
| --- | --- | --- |
| `provider-usage` | 10 | 隐藏用量内容 |
| `token-meter` | 20 | 隐藏指标内容 |

扩展声明唯一标识与有限数值优先级，数值越小越靠前。共享组件接受任意字符串标识，不保存扩展位置表。扩展获取自身子组件的写入句柄：

```ts
import { acquireWidgetPart } from "@pi-kits/shared/ui/widget";

const component = acquireWidgetPart(ctx.ui, "token-meter", 20);
component.update("TTFT 0.8s · TPS 63 token/s");
component.update(""); // 隐藏内容，保留句柄
component.dispose(); // 释放组件
```

`update()` 的内容始终为字符串；第二个参数为颜色，可取 `dim`、`warning`，默认 `dim`。每个子组件独立持有文本和颜色，共享父组件只读取子组件的渲染结果。

父组件首次更新时挂载一次。后续更新只修改对应子组件并通知父组件请求重绘，保持父组件和其他子组件的身份不变。释放或被新句柄替换的写入句柄忽略后续更新和重复释放。

`ui/widget-layout.ts` 的纯函数 `layoutWidgetParts()` 集中处理布局：

- 过滤空输出，按优先级升序排列；同优先级按标识排序，使结果独立于加载顺序。
- 相邻两个组件组成一组；两者加至少两列间隔能完整放下时，前者左对齐、后者右对齐。
- 一组放不下时，两者分别独占一行并左对齐；单个组件独占一行仍超宽时才裁剪。
- 最后一组只有一个组件时左对齐；任意数量的组件按相同规则生成多行。

组件在渲染时读取宽度与主题，终端缩放后重新排版；全部输出为空时渲染零行，最后一个组件释放后移除 widget。

父组件注册表通过进程级版本化 Symbol 共享，确保 Pi 独立加载各扩展时连接同一个父组件；注册表内部使用 WeakMap，按 Pi UI 对象隔离。扩展在会话关闭时释放自己的句柄。共享 helper 负责完整布局和重绘，扩展负责生命周期事件。

`ui/widget-layout.test.ts` 覆盖纯函数排序、空输出过滤、多行配对、换行边界和 Unicode 裁剪；`ui/widget-row.test.ts` 覆盖独立子组件、父组件单次挂载、更新通知、失效句柄、动态排版、主题变化和 UI 隔离。根目录的 `tests/widget-row-loader.test.ts` 在独立 Node 进程中通过 Pi 加载器验证两种加载顺序、交替刷新、父组件身份、单项清理与重新加载。

## 工具结果渲染

`ui/renderers.ts` 提供统一工具卡片渲染。折叠时显示名称、状态和有限预览，Ctrl+O 展开完整内容及结构化详情。流式输出、取消、错误和截断保留明确状态；渲染不改变模型可见内容或机器输出。
