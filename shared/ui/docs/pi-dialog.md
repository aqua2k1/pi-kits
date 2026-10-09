# Pi 基础对话适配器

`@pi-kits/shared/ui/adapters/pi-dialog` 导出 `createPiDialogAdapter(ui)`，
通过 Pi 已有 select/input 呈现通用协议。它是明确的顺序对话、纯文本降级，
不是自定义 TUI，也不是 Web renderer。

## 接入

业务用例应使用 UIHost，不直接创建 Pi-dialog。扩展入口示意：

```ts
import { bindUIHost } from "@pi-kits/shared/ui/host";

const host = bindUIHost(ctx);
try {
  const session = host.open(view, {
    onEvent(event, current) {
      // 业务处理 change/invoke 并 publish 新快照。
      if (event.type === "dismiss") current.close("dismissed");
    },
  });
  const lifecycle = await session.closed;
} finally {
  await host.dispose();
}
```

调用方须确保 ctx.hasUI，绑定当前有效上下文和操作 signal；会话切换、reload
或宿主关闭时中止会话。适配器不注册工具或决定业务结果；问卷的非 TUI 路径
已经通过扩展自己的 controller/interaction 模块接入，原 TUI 仍保留。

## 呈现与交互

- group 按声明顺序展开为标题和说明，不还原 tabs/列布局。
- content 的完整正文以纯文本显示；Markdown/JSON 不执行、不额外解析。
  status 显示为文本标记，summary 不替代正文，也不会自动截断文档。
- 字段显示当前值、说明与校验反馈；可编辑字段进入主菜单。
- text 使用 input；第二参数只传 placeholder，当前值在标题中展示，
  不冒充预填值。Pi 本地 1.0.0 TUI 对 placeholder 的实际显示有限。
- single 选择选项 ID，提供 Clear selection，允许 null。
- multiple 逐项切换本地草稿，Done 后只发一个 change；取消编辑不提交草稿。
- filterable 选择字段提供 Filter options：按标签与说明做不区分大小写的
  子串筛选，空字符串清除筛选；不是 commit 旧 TUI 的模糊匹配界面。
- 禁用/只读字段只显示，不可进入编辑；禁用 action 不列为可执行操作。
  已选禁用选项可以保留或移除，不允许重新添加。
- action 发 invoke；destructive 只显示语义提示，不代替业务授权或确认。
- 每个菜单项有独立序号，不依赖标签作身份，允许重复标签。
- 主菜单取消或 Close 发 dismiss，是否关闭由业务控制器决定；
  子对话取消只返回主菜单，刷新中止不是用户 dismiss。

输出的终端控制字符被转为可见转义文本，菜单标签按单行处理。
适配器不修改业务原始输入值，也不提供脱敏或访问授权。

## 更新与生命周期

订阅新快照后中止旧对话并读取最新 revision 重绘；旧响应不会作为新快照的事件。
字段编辑与筛选的本地草稿在快照刷新时放弃，当前阶段不合并跨 revision 的草稿。

同一个适配器实例同时只能挂载一个 session，清理完成后可以复用。
共享 bindUIHost 将同一 ui 对象绑定到同一适配器资源，并在 session 完全清理前
拒绝并发 open，见 [host API](host.md)。这不等于整个 SDK 的全局对话排队；
绕过 host 的直接调用或不同 ui 包装对象仍需要调用方协调。

对话循环通过 UIMount.completion 报告后台失败。宿主 select/input 失败、未知
选项响应或业务事件失败会关闭 session；dispose 等待循环结算并释放订阅。
正常关闭、中止与快照刷新均将 signal 传给 Pi 对话，不用 Promise.race 假装
已经释放仍在宿主中的对话。

## RPC 限制

已核对项目安装的 Pi 1.0.0 类型与实现；全局文档目录对应 1.1.0，不能只依赖
全局文档推断安装行为。select/input 支持第三参数 signal，正常 abort 返回
undefined。适配器根据本地 signal 区分用户取消与刷新/会话中止。

**当前 Pi RPC 没有 agent→客户端的对话关闭消息。** signal 中止只清理后端
pending request，迟到响应被忽略，不保证远端客户端立即关掉旧对话。
刷新会发出新请求，客户端必须管理串行展示；本适配器不补造 SDK 不支持的 wire
协议。真实远端关闭、重连和多前端能力仍需后续 remote 与能力协商方案。
