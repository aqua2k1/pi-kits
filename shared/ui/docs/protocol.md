# 通用 UI 协议 API

第一阶段已实现节点、完整视图快照和语义事件校验。
进程内会话与适配器契约见 [session.md](session.md)；尚无 host、真实前端
适配器或现有扩展迁移。总体设计见 [protocol-design.md](protocol-design.md)。

## 导入

```ts
import {
  assertUIEventForView,
  assertUIView,
  type UIView,
} from "@pi-kits/shared/ui/protocol";

const view: UIView = {
  id: "example",
  revision: 0,
  root: {
    kind: "group",
    id: "root",
    children: [
      { kind: "field", id: "name", type: "text", label: "Name", value: "" },
      { kind: "action", id: "save", label: "Save", emphasis: "primary" },
    ],
  },
};

assertUIView(view);
assertUIEventForView(view, {
  viewId: "example",
  revision: 0,
  type: "change",
  nodeId: "name",
  value: "New name",
});
```

该子路径没有 Pi、TUI、Node 或扩展依赖，也没有注册副作用。
类型定义见 `../protocol/types.ts`，运行时校验见 `../protocol/validate.ts`。

## 节点

所有节点有非空白 `id`，整棵视图树内不可重复。

- `group`：`children`，可选 `title`、`description`。
- `content`：`format` 为 text/markdown/json，`body` 为字符串，可选 `summary`、
  `status`。格式是展示语义，不执行 Markdown 或解析/校验 JSON 正文。
- `field`：`label`、`type`、`value`，可选 description/disabled/readOnly/error。
  text 的 value 是字符串；single 是选项 ID 或 null；multiple 是选项 ID 数组。
  选择字段有 `options` 和可选 `filterable`，text 可有 `placeholder`。
- `action`：`label`、可选 `disabled` 和 default/primary/destructive 的 `emphasis`。

选项有 id、label、可选 description/disabled；ID 在一个字段内唯一，显示标签
允许重复。多选值不允许重复 ID；视图中当前选项必须存在，但允许保留已禁用选项。
空文本、null、空数组与空选项集合是合法结构，必选与非空答案规则仍由业务负责。
collection 及图形变体暂未实现。

## 视图与事件

UIView 为 `{ id, revision, root }`；revision 为非负安全整数。
本模块校验 revision 的结构，不维护历史或检查快照更新是否递增。

事件都携带 `viewId` 和 `revision`：

- `change`：`nodeId` 与字段值。
- `invoke`：action 的 `nodeId`。
- `dismiss`：用户关闭意图，无 nodeId，不直接决定业务取消结果。

公开函数：

- `assertUIView(unknown)`：检查 JSON 数据、节点结构和 ID/值引用。
- `assertUIEvent(unknown)`：检查事件结构，不关联具体视图。
- `assertUIEventForView(view, unknown)`：同时校验当前视图与事件、viewId/revision、
  目标类型和可用状态、字段值及选项。禁止新增禁用选项，但允许保留或取消已选项。

失败抛出 `UIProtocolError`，错误消息不包含用户输入或文档正文。
校验不修改数据，也不执行事件；更新与事件顺序、完成与中止由 session 处理，
业务授权由 controller 处理，远端去重仍待实现。通过校验不代表可执行任意业务操作。

## 数据边界

严格拒绝未知字段、显式 undefined、函数、非有限数、类实例、getter/setter、
symbol、非枚举属性、稀疏/扩展数组和循环引用。可选字段应省略，而不是设为
undefined。只接受普通 JSON 对象与数组；不接受 Object.create(null) 对象。

事件的 revision 必须与快照一致，过期或未来事件都会被拒绝。
网络协议版本、连接身份、消息大小限制、授权和重连不是本模块的能力。
节点内容仍须由业务选择性投影；文档展示适配器负责安全渲染和终端字符处理。
