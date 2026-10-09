# UI 交互 session 与适配器契约

`@pi-kits/shared/ui/session` 实现一个视图、业务控制器和适配器之间的会话绑定。
它不注册 Pi 处理器、不持有全局宿主。Pi 基础对话的实现见
[Pi 对话适配器](pi-dialog.md)，自定义 TUI/Web 适配器仍待实现。
节点与事件见 [协议 API](protocol.md)。

## 接口

```ts
import {
  createUISession,
  type UIAdapter,
} from "@pi-kits/shared/ui/session";
import type { UIView } from "@pi-kits/shared/ui/protocol";

function open(view: UIView, adapter: UIAdapter, signal?: AbortSignal) {
  return createUISession(view, {
    adapter,
    signal,
    onEvent(event, session) {
      if (event.type === "dismiss") {
        // 业务控制器在这里决定取消用例、保留哪些结果。
        session.close("dismissed");
      }
      // change/invoke 由业务处理，再 publish 新视图或 close。
    },
  });
}
```

UISession：

- `getSnapshot()` 返回 session 拥有的深度冻结快照。
- `publish(view)` 发布相同 view ID、严格递增 revision 的完整快照。
- `subscribe(listener)` 订阅快照变更，返回可重复调用的解除订阅函数。
- `dispatch(event)` 返回 Promise，事件经过结构与当前视图校验后交给业务。
- `close("completed" | "dismissed")` 发起正常关闭；重复关闭无效。
- `signal` 在任何关闭时中止，供适配器与控制器停止工作。
- `closed` 在挂载结算、正在处理的事件结束、适配器清理和关闭回调完成后，
  解析为 `{ status, error? }`。若有后台 completion 也会等待它结算。
  它不 reject，也不携带业务最终结果。

业务结果继续由业务控制器或用例拥有；dismiss 是交互意图，不自动终止业务。

## 适配器

UIAdapter 实现 `mount(port)`，返回或异步返回 `{ dispose(), completion? }`。
completion 用于后台交互循环：reject 会使会话失败，正常 resolve 不自动关闭。
closed 会等待 completion 结算；dispose 必须停止循环，不能等待 closed。
不需要后台循环的同步组件可以省略 completion。
UIPort 只暴露 getSnapshot、subscribe、dispatch 和 signal，不暴露 publish/close。
因此 renderer 只发送语义事件，不直接改变业务状态或完成业务。

mount 在微任务中启动，调用方先拿到 session。适配器挂载时读最新快照，
通过订阅追踪后续更新；若挂载中止但已经拿到资源，应返回可清理的 mount，
或在抛出错误前清理部分挂载。session 无法清理尚未交付的资源。

`dispose` 可以异步，必须恢复宿主并释放监听、订阅和组件等适配器资源。
session 对返回的 mount 仅调用一次 dispose。关闭后会清空 session 自己的订阅。

## 事件与快照顺序

- 初始快照、发布快照与事件先验证再复制；调用方后续修改不影响会话。
- 同一 session 的事件串行处理，不并发执行业务回调。
- 队列事件在执行时重新校验 revision 和目标状态；前一事件发布新快照后，
  原 revision 的后续事件会被拒绝，不自动改写或重放。
- 非法、过期或不可用目标事件 reject，但不会自行关闭会话。
- onEvent 抛错或 reject 会关闭为 error，dispatch 同时 reject。
- close 拒绝尚未执行的队列事件；正在执行的事件允许结算。
- publish 的结构、ID 或 revision 不合法时抛错且不改变快照。
- 订阅回调抛错视为适配链失败：会话关闭，publish 抛出该错误。

适配器必须观察 dispatch rejection。处理连续编辑时需根据最新快照协调事件，
不能盲目发送多个相同 revision 的变更后假定它们全部成功。

## 生命周期与错误

关闭状态为 completed/dismissed/aborted/error。外部 signal 预先中止时不挂载；
挂载过程中关闭，等待 mount 结算后清理，避免资源留在宿主。

onOpen 在 mount 成功且尚未关闭时调用，不代表浏览器已经挂载或终端已绘制。
onClosed 在挂载与事件结算、清理后调用，即使从未打开也会调用一次。

第一个实际错误保留在 error 中；清理或关闭回调失败不覆盖先前错误。
若外部中止已经触发关闭，后续失败仍保持 aborted 状态，同时保留错误。
已发起关闭后外部 abort 不再改变此次关闭的状态。

所有异步挂载、事件和打开回调都必须协作式停止并及时结算；无法中止的 Promise
不会被强行丢弃。不要在 mount、onEvent、onOpen、dispose 或 onClosed 内等待
当前 session.closed，也不要在 onEvent 内等待自己排入同一队列的 dispatch，
否则形成循环等待。控制器执行异步业务操作时应观察 session.signal。

## 未实现的能力

宿主绑定与资源协调见 [host API](host.md)，适配器配置不属于业务用例。
仍未实现能力协商、连接授权、远端传输或事件去重。
本模块的 AbortSignal 和 controller 回调是进程内接口，不属于 wire 协议。
内存适配器仅在测试中验证契约；已有 Pi 基础对话适配器，真实 TUI/Web/GUI
renderer 与远端生命周期仍需独立实现和端到端验证。
