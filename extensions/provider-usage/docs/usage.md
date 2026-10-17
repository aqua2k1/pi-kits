# 使用

## /usage

```text
/usage
```

命令立即刷新当前数据源，并用通知反馈最新显示行；警告结果使用警告级别通知（[入口](../index.ts)、[测试](../index.test.ts)）。

| 主会话模型的服务商标识 | 编辑器下方的显示内容 |
|---|---|
| `deepseek` | 各币种余额；任一币种余额低于 20 时显示警告色 |
| `openai-codex` | ChatGPT 套餐、各窗口已用百分比和重置倒计时；任一窗口达到 80% 时显示警告色 |

显示内容来自 [deepseek.ts](../deepseek.ts) 和 [chatgpt.ts](../chatgpt.ts)；服务商标识按主会话模型匹配（[入口](../index.ts)）。

ChatGPT 的窗口指服务端报告的用量周期，标签为 `5h`、`daily`、`weekly`、`monthly`、`annual`，其余周期显示 `limit`；返回多个窗口时同时展示，套餐字段缺失时省略套餐名称（[实现](../chatgpt.ts)、[测试](../chatgpt.test.ts)）。

倒计时保留两个单位：短于一天的窗口显示小时和分钟，其他窗口显示天和小时；到期窗口省略倒计时（[实现](../chatgpt.ts)、[测试](../chatgpt.test.ts)）。

会话启动和模型选择触发刷新，并启动定时刷新；间隔与请求超时见[配置](configuration.md)（[入口](../index.ts)、[测试](../index.test.ts)）。

认证来自 Pi 模型注册表；凭据缺失时隐藏组件并停止轮询，选择模型或重新启动会话可重新触发认证读取（[入口](../index.ts)）。

刷新失败时，已有成功缓存显示 `(stale)`，表示保留的旧结果；没有缓存时显示占位行和错误简因。接口返回空数据时显示占位行并保留缓存（[入口](../index.ts)、[测试](../index.test.ts)）。

ChatGPT 返回 HTTP 401 时清除其缓存，并提示重新登录；提示中的操作为：

```text
/login openai-codex
```

该恢复提示由 [chatgpt.ts](../chatgpt.ts) 提供，并由[生命周期测试](../index.test.ts)验证。
