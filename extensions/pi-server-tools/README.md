# pi-server-tools

在请求发送前为支持的模型自动注入厂商原生服务端工具。

## 安装

```sh
pi install https://github.com/aqua2k1/pi-kits.git
```

## 快速开始

```sh
pi config
```

启用 `pi-server-tools` 后正常对话，支持的模型自动获得对应服务端工具，无须额外配置：

| 提供方 | 协议 / 模型 | 注入的服务端工具 |
| --- | --- | --- |
| OpenAI / Codex | Responses API | `web_search`、`image_generation` |
| Google / Vertex | Generative AI / Vertex | `googleSearch`、`urlContext` |
| DeepSeek | `deepseek-v4-pro`（Responses API） | `web_search` |
| DeepSeek | `deepseek-flash`（Chat Completions API） | `deepseek_web_search`、`deepseek_read_url` |

其他提供方、协议或已有同名工具的请求保持原样透传。
