# 配置

配置位置：`<agent-dir>/pi-kits.json`，配置键 `web-kits`；下表 JSON 键均相对此键。目录解析与重载见[共享配置](../../../shared/config/README.md)。字段取自 [schema](../../../shared/config/schema.ts)，schema 未声明的运行默认值见 [WEB_DEFAULTS](../../../shared/config/index.ts) 与[扩展配置解析](../config.ts)。

| 键 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `enabled` | boolean | `true` | 控制工具、诊断命令注册和启动时临时文件清理 |
| `search.enabled` | boolean | `true` | 控制 `web_search` 注册和诊断搜索测试 |
| `search.routing.provider` | string | `searxng` | 主服务；枚举为 `searxng`、`codex-alpha-search`、`codex`，其中 `codex` 是后者的别名 |
| `search.routing.fallback` | boolean | `false` | 主服务发生符合回退条件的错误时启用备用服务；条件见[路由错误策略](../core/errors.ts) |
| `search.routing.fallbackProvider` | string | 未设置；路由选另一服务 | 备用服务；枚举同 `search.routing.provider` |
| `search.timeoutMs` | integer | `15000` | 每次搜索尝试的超时毫秒数，覆盖认证、请求与响应读取 |
| `search.maxResults` | integer | `5` | 工具省略 `max_results` 时的结果数量，也用于注册参数默认值 |
| `search.codex.model` | string | `gpt-5.4` | 发送给 Codex 搜索服务的模型名 |
| `fetch.enabled` | boolean | `true` | 控制 `web_fetch` 注册及启动时临时文件清理 |
| `fetch.timeoutMs` | integer | `15000` | 原生 HTTP 请求及 GitHub API 命令的超时毫秒数 |
| `fetch.github.enabled` | boolean | `true` | 启用 GitHub 仓库 URL 专用处理 |
| `fetch.github.mode` | string | `auto` | 枚举为 `auto`、`clone`、`api`；策略见[使用](usage.md#web_fetch) |
| `fetch.github.maxRepoSizeMB` | integer | `350` | `auto` 模式以 MiB 为单位判断仓库大小，超过阈值走 API |
| `fetch.github.cloneTimeoutSeconds` | integer | `30` | 单次克隆命令的超时秒数 |
| `fetch.github.clonePath` | string | 系统临时目录下的 `pi-web-tools-github` | 克隆缓存的父目录 |
| `SEARXNG_URL`（环境变量） | string | `http://localhost:8080` | SearXNG 地址；启动 Pi 前示例：`export SEARXNG_URL="https://<searxng-host>"` |
| `SEARXNG_API_KEY`（环境变量） | string | 未设置 | SearXNG Bearer 认证密钥；启动 Pi 前示例：`export SEARXNG_API_KEY="<api-key>"` |

## 示例

```json
{
  "web-kits": {
    "enabled": true,
    "search": {
      "enabled": true,
      "routing": {
        "provider": "searxng",
        "fallback": false,
        "fallbackProvider": "codex-alpha-search"
      },
      "timeoutMs": 15000,
      "maxResults": 5,
      "codex": {
        "model": "MODEL_ID"
      }
    },
    "fetch": {
      "enabled": true,
      "timeoutMs": 15000,
      "github": {
        "enabled": true,
        "mode": "auto",
        "maxRepoSizeMB": 350,
        "cloneTimeoutSeconds": 30,
        "clonePath": "/<clone-directory>"
      }
    }
  }
}
```

字段校验规则见 [shared/config/schema.ts](../../../shared/config/schema.ts)；服务名关系校验见[共享解析器](../../../shared/config/index.ts)，环境变量解析见[配置源码](../config.ts)及 [SearXNG 配置](../providers/searxng/config.ts)。
