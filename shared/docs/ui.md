# 共享 UI

## 项目目标

[UI 项目目标](../ui/docs/goals.md)单独记录目标与验收方向；
[UI 协议与适配边界](../ui/docs/architecture.md)记录设计与演进策略：
将 UI 协议与 TUI/WebUI/GUI 差异集中在 `shared/ui/`，扩展只表达业务数据与
交互意图。采用语义协议而非通用控件 DSL，按实际需求渐进迁移。
这是目标架构；以下内容描述当前实现。

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

## 工具结果渲染

`ui/renderers.ts` 提供统一工具卡片渲染。折叠时显示名称、状态和有限预览，Ctrl+O 展开完整内容及结构化详情。流式输出、取消、错误和截断保留明确状态；渲染不改变模型可见内容或机器输出。
