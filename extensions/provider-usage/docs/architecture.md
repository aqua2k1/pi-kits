# 架构

[index.ts](../index.ts) 按主会话模型选择单个数据源，协调认证、轮询、缓存和组件显示；[source.ts](../source.ts) 定义适配器契约，[deepseek.ts](../deepseek.ts) 与 [chatgpt.ts](../chatgpt.ts) 负责请求和展示数据转换。配置读取使用[共享配置](../../../shared/config/README.md)。

## 文件地图

| 文件 | 职责 |
|---|---|
| [index.ts](../index.ts) | 注册命令和生命周期事件，协调刷新与显示 |
| [source.ts](../source.ts) | 数据源契约、组件标识与 HTTP 错误 |
| [deepseek.ts](../deepseek.ts) | DeepSeek 余额请求、币种展示与预警 |
| [chatgpt.ts](../chatgpt.ts) | ChatGPT 认证头、窗口标签、倒计时与预警 |
| [package.json](../package.json) | 扩展入口、资源名与测试脚本 |

## 数据流

1. 扩展工厂读取配置；启用后注册 `/usage` 及会话、模型事件（[index.ts](../index.ts)）。
2. 会话启动或模型选择按服务商标识选择适配器，展示已有缓存并开始刷新（[index.ts](../index.ts)）。
3. 刷新从模型注册表读取对应服务商凭据，再将凭据和取消信号交给适配器（[index.ts](../index.ts)、[source.ts](../source.ts)）。
4. 适配器请求远程接口，转换显示行和预警数据（[deepseek.ts](../deepseek.ts)、[chatgpt.ts](../chatgpt.ts)）。
5. 协调层缓存成功结果并更新组件；手动刷新额外发送通知，失败呈现规则见[使用](usage.md)（[index.ts](../index.ts)）。

## 约束

- 数据源的服务商标识同时用于模型匹配、凭据读取与缓存索引，三者保持一致以免凭据送往错误端点（[index.ts](../index.ts)、[数据源切换测试](../index.test.ts)）。
- 每次刷新在等待认证前固定数据源与注册表身份、递增代次并取消前次请求，异步返回后检查身份与代次，防止切换或关闭后的旧凭据发起请求、旧结果覆盖当前组件（[index.ts](../index.ts)、[竞态测试](../index.test.ts)）。
- 适配器传递调用方的取消信号，并以共享 HTTP 错误携带状态码，使协调层的超时取消和认证恢复分支保持有效（[source.ts](../source.ts)、[适配器测试](../source.test.ts)）。
- 缓存仅保存成功数据，空数据和失败展示不覆盖缓存，以便后续失败仍能展示最近成功结果（[index.ts](../index.ts)、[缓存测试](../index.test.ts)）。
- 预警由适配器依据用量数据判定，协调层将同一判定用于组件颜色和通知级别，避免两种反馈不一致（[source.ts](../source.ts)、[index.ts](../index.ts)、[预警测试](../index.test.ts)）。
- 认证恢复文案由适配器提供，协调层仅在对应 HTTP 401 分支清除缓存并展示，避免 DeepSeek 错误出现 ChatGPT 登录提示（[chatgpt.ts](../chatgpt.ts)、[index.ts](../index.ts)、[测试](../index.test.ts)）。

## 测试

在仓库根目录执行（脚本见 [package.json](../package.json)）：

```sh
npm test --workspace=pi-provider-usage
```

- [index.test.ts](../index.test.ts)：注册、服务商切换、刷新通知、缓存、认证竞态、轮询、超时、关闭和配置。
- [source.test.ts](../source.test.ts)：两种适配器的凭据、HTTP 错误、空数据、取消信号与预警。
- [chatgpt.test.ts](../chatgpt.test.ts)：多窗口、双单位倒计时和账号认证头。
