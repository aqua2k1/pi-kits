# 配置

配置位置：`<agent-dir>/pi-kits.json`，配置键 `web-kits`；表中 JSON 键均相对此键。扩展加载时读取文件和环境变量快照，重新加载扩展后生效；文件缺失使用默认值，校验失败时报错。agent 目录解析见[共享配置](../../../shared/config/README.md)。

| 键 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `enabled` | boolean | `true` | 控制工具、诊断命令注册与加载时的临时文本清理 |
| `search.enabled` | boolean | `true` | 控制 `web_search` 注册及诊断搜索测试 |
| `search.routing.provider` | string | `searxng` | `searxng`、`codex-alpha-search`、`codex`；`codex` 是后者别名 |
| `search.routing.fallback` | boolean | `false` | 主服务发生认证、能力、限流、网络、超时、无效响应或服务端错误时尝试备用服务 |
| `search.routing.fallbackProvider` | string | 未设置；路由选择另一服务 | 枚举同主服务；归一化别名后须与配置主服务不同 |
| `search.timeoutMs` | integer | `15000` | 1000–120000；每次搜索尝试的超时毫秒数，覆盖认证、请求和响应读取 |
| `search.maxResults` | integer | `5` | 1–10；工具省略 `max_results` 时的结果数量 |
| `search.codex.model` | string | `gpt-5.4` | 1–128 字符，仅字母、数字、点、下划线和连字符；Codex 搜索模型名 |
| `fetch.enabled` | boolean | `true` | 控制 `web_fetch` 注册及加载时的临时文本清理 |
| `fetch.timeoutMs` | integer | `15000` | 1000–120000；原生 HTTP 流程及单次 GitHub API 命令的超时毫秒数 |
| `fetch.github.enabled` | boolean | `true` | 启用 GitHub 仓库 URL 专用处理 |
| `fetch.github.mode` | string | `auto` | `auto` 按大小选择 API 或克隆；`clone` 优先克隆；`api` 使用 API；完整提交 SHA 使用 API |
| `fetch.github.maxRepoSizeMB` | integer | `350` | 1–10240；`auto` 模式超过此 MiB 阈值时走 API |
| `fetch.github.cloneTimeoutSeconds` | integer | `30` | 5–600；单次克隆命令的超时秒数 |
| `fetch.github.clonePath` | string | 系统临时目录下的 `pi-web-tools-github` | 含非空白字符，去除首尾空白后作为克隆缓存父目录 |
| `SEARXNG_URL`（环境变量） | string | `http://localhost:8080` | HTTP(S) 地址，最多 2048 字符；用户名、密码、查询与片段须留空；启动前设置 `export SEARXNG_URL="https://<searxng-host>"` |
| `SEARXNG_API_KEY`（环境变量） | string | 未设置 | Bearer 密钥，去除首尾空白后最多 4096 个可见 ASCII 字符；启动前设置 `export SEARXNG_API_KEY="<api-key>"` |

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
        "model": "model-id"
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

字段校验规则见 [shared/config/schema.ts](../../../shared/config/schema.ts)；运行默认值与主备服务关系校验见 [shared/config/index.ts](../../../shared/config/index.ts)。
