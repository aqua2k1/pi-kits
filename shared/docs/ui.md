# 共享 UI

## Shared terminal UI

Reusable UI lives in `shared/ui/`, independently of the tool schema and
extension registration:

- `@pi-kits/shared/ui/tabs`: `layoutTabs(labels, active, width)` and `tabAt`
  provide a bounded tab viewport and component-local mouse hit testing.
- `@pi-kits/shared/ui/panel`: `fillPanel` and `panelRule` provide opaque
  padded frames, pinned footer rows, and width-safe rules.
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
