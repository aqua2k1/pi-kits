# 配置

配置位置：`<agent-dir>/pi-kits.json`，配置键 `web-kits`；表中 JSON 键均相对此键。扩展加载时读取文件和环境变量快照，重新加载扩展后生效；文件缺失使用默认值，校验失败时报错。agent 目录解析见[共享配置](../../../shared/config/README.md)。

| 键 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `enabled` | boolean | `true` | 控制工具、诊断命令注册与加载时的临时文本清理 |
| `search.enabled` | boolean | `true` | 控制 `web_search` 注册及所有诊断搜索测试；开启时至少启用一个来源 |
| `search.sources.web.enabled` | boolean | `true` | 控制网页搜索分支暴露与执行，以及网页连接测试 |
| `search.sources.web.routing` | string[] | `["searxng"]` | 1–2 项且不重复，枚举 `searxng`、`codex-alpha-search`；依序主备，单服务无备用；认证、能力、限流、网络、超时、无效响应或服务端错误触发备用 |
| `search.sources.web.codex.model` | string | `gpt-6-luna` | 1–128 字符，仅字母、数字、点、下划线和连字符；Codex 搜索模型名 |
| `search.sources.github.enabled` | boolean | `true` | 控制 GitHub 搜索分支与测试；使用本地只读 `gh api`，认证由 `gh` 提供，无路由字段 |
| `search.routing.provider`（旧） | string | `searxng` | `searxng`、`codex-alpha-search`、`codex`；`codex` 是后者别名；旧 `search.routing`／`search.codex` 与新 `search.sources.web` 不能混用 |
| `search.routing.fallback`（旧） | boolean | `false` | 转换为网页路由是否含第二项 |
| `search.routing.fallbackProvider`（旧） | string | 未设置；启用回退时选择另一服务 | 枚举同旧主服务；归一化别名后须与主服务不同；关闭回退时无备用 |
| `search.timeoutMs` | integer | `15000` | 1000–120000；每次搜索尝试的超时毫秒数，覆盖认证、请求和响应读取 |
| `search.maxResults` | integer | `5` | 1–10；工具省略 `max_results` 时的结果数量 |
| `search.codex.model`（旧） | string | `gpt-6-luna` | 校验规则同新模型字段，兼容旧网页模型配置 |
| `fetch.enabled` | boolean | `true` | 控制 `web_fetch` 注册及加载时的临时文本清理 |
| `fetch.timeoutMs` | integer | `15000` | 1000–120000；原生 HTTP 流程及单次 GitHub API 命令的超时毫秒数 |
| `fetch.github.enabled` | boolean | `true` | 启用 GitHub 仓库 URL 专用处理 |
| `SEARXNG_URL`（环境变量） | string | `http://localhost:8080` | HTTP(S) 地址，最多 2048 字符；用户名、密码、查询与片段须留空；启动前设置 `export SEARXNG_URL="https://<searxng-host>"` |
| `SEARXNG_API_KEY`（环境变量） | string | 未设置 | Bearer 密钥，去除首尾空白后最多 4096 个可见 ASCII 字符；启动前设置 `export SEARXNG_API_KEY="<api-key>"` |

## 示例

```json
{
  "web-kits": {
    "enabled": true,
    "search": {
      "enabled": true,
      "timeoutMs": 15000,
      "maxResults": 5,
      "sources": {
        "web": {
          "enabled": true,
          "routing": ["searxng", "codex-alpha-search"],
          "codex": { "model": "gpt-6-luna" }
        },
        "github": { "enabled": true }
      }
    },
    "fetch": {
      "enabled": true,
      "timeoutMs": 15000,
      "github": {
        "enabled": true
      }
    }
  }
}
```

字段校验规则见 [shared/config/schema.ts](../../../shared/config/schema.ts)；运行默认值与主备服务关系校验见 [shared/config/index.ts](../../../shared/config/index.ts)。
