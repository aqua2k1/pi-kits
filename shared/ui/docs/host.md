# 通用 UI host

`@pi-kits/shared/ui/host` 是业务与具体前端之间的入口。业务用例只接收 UIHost，
不创建适配器、不接收 PiDialogUI，也不调用 select/input。

## 业务接口

```ts
import type { UIHost } from "@pi-kits/shared/ui/host";

function run(host: UIHost) {
  return host.open(view, {
    signal,
    onEvent(event, session) {
      // 业务处理语义事件，发布新视图或完成交互。
      if (event.type === "dismiss") session.close("dismissed");
    },
  });
}
```

UIHost 提供：

- `open(view, options)`：创建 session；options 不含 adapter。
- `dispose()`：中止自己拥有的交互并等待 session 清理，重复调用返回同一 Promise。

业务请求结束后用例等待 session.closed，业务结果仍由用例持有。
借用 host 的用例不自行 dispose；创建绑定的入口负责释放 host。
绑定与请求中止由共享 host 归一化为公开 UIHostOutcome：status 为 aborted，
若没有更早的实际错误，error 保留原取消原因。宿主已释放则拒绝新请求。
扩展只消费 session.closed 或 onClosed 的公开生命周期结果，不检查 host 内部
signal。取消/错误不能在扩展中通过拼接不同底层状态自行分类。

## 宿主绑定与适配器配置

扩展入口负责连接当前 Pi 上下文，但具体前端的选择留在共享目录：

```ts
import { bindUIHost } from "@pi-kits/shared/ui/host";

const host = bindUIHost(ctx);
try {
  await runBusinessUseCase(host);
} finally {
  await host.dispose();
}
```

bindUIHost 接收 hasUI、ui、可选 signal；无 UI 时立即报错。
当前共享策略使用 Pi 基础对话降级，不根据扩展名称选择 renderer。
它只缓存相同 ui 对象对应的适配器，不缓存 ctx、操作 signal 或可复用的全局 host。
每次调用得到具有独立生命周期的新绑定。

`createUIHost(adapter, { signal? })` 是前端配置入口，可供共享目录中的其他适配器
或测试使用；业务控制器不应通过它选择具体前端。未来 Web/GUI 可提供相同
UIHost 接口而不改业务用例。

## 并发与清理

- 同一适配器资源同一时间只接收一个 session，清理完成前新 open 抛
  UIHostBusyError，不隐式排队或覆盖正在交互的视图。
- 相同 ui 对象的多个 bindUIHost 绑定共享该资源限制。
- dispose 只中止本绑定拥有的 session；释放闲置绑定不会取消其他绑定的交互。
- 请求 signal 只取消当前请求；绑定 signal 或 dispose 取消整个绑定。
  内部生命周期 token 不作为 UIHost 属性暴露。
- 正常请求结束后可继续用当前 host 发起新请求；已 dispose 的 host 抛
  UIHostDisposedError。
- 适配器后台循环、dispose、onClosed 等全部结算后才释放资源租约。
- 对已中止但未释放的绑定，open 返回 aborted 生命周期结果，不挂载 UI。
- session 错误仍由归一化后的 session.closed 提供；host.dispose 等待清理但不重复抛出该错误，
  避免入口清理覆盖业务已收到的原始失败。

不要在 session 的 mount、onEvent、onOpen、dispose 或 onClosed 内等待
host.dispose，因其等待当前 session.closed，可能产生循环等待。
本层仅协调同一适配器或同一 ui 对象的 host 请求；直接调用 SDK 对话、
绕过 host 创建 session 或不同 SDK ui 包装对象不受这条租约统一保护。

## 当前迁移状态

问卷非 TUI 用例位于 `extensions/ask-user-question/interaction.ts`，只接收 UIHost。
业务控制器仍拥有答案、草稿与确认规则。扩展入口 bind/dispose 宿主；
原问卷 TUI 暂时保留独立入口，尚未统一到 host。

旧 TUI 尚未接入 host；无公开 host 生命周期结果的旧调用可用共享
classifyUIFailure 对调用方提供的请求 signal 分类，扩展不自行实现该规则。
host 路径消费 UIHostOutcome.status，不能重新推断内部取消状态。
若 open 本身抛错且没有公开 outcome（例如资源忙），应报告 error，不能用请求
signal 将其改标为 aborted。

本轮没有自定义 TUI、Web/GUI renderer 或能力协商实现；Pi RPC 无远端关闭
消息的限制仍然存在，见 [Pi 对话适配器](pi-dialog.md)。
