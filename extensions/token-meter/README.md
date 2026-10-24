# token-meter

在 Pi 状态栏显示最近一次模型请求的首字延迟和输出吞吐率。

## 安装

```sh
pi install https://github.com/aqua2k1/pi-kits.git
```

## 快速开始

```sh
pi config
```

启用 token-meter，在 Pi 交互界面正常发送消息。模型响应结束后，状态栏显示：

```text
TTFT 0.8s · TPS 63 token/s
```

每次模型响应结束后同时更新两个指标；生成期间和工具执行期间保留上次结果。新会话显示 `TTFT — · TPS —`。

- **TTFT**：请求发送前到首个非空正文片段的时间，包含网络、排队和正文前的 thinking 等待。
- **TPS**：接口报告的输出 token 数除以模型响应耗时，包含首字等待，以及接口计入的 thinking 和工具调用 token。
- 响应耗时优先使用 Pi 的响应计时，缺失时使用请求发送前到响应结束的本地单调时钟计时。工具执行位于模型响应之外，不计入 TPS。
- 缺少必要数据时，相应指标显示 `—`；失败或取消的响应保留已测得的 TTFT，TPS 显示 `—`。

正文缺失时 TTFT 显示 `—`；thinking 摘要长度不参与 token 用量计算。

扩展在交互式终端显示状态，监听正常请求并在内存中统计；会话切换或重载时清空结果。

## 文档

- [架构](docs/architecture.md)
