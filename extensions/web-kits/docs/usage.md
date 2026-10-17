# 使用

## web_search

```json
{
  "query": "<检索主题>",
  "provider": "searxng",
  "max_results": 5,
  "domains": ["example.com", "*.example.org"],
  "recency_days": 7
}
```

工具通过 SearXNG 或 Codex `alpha/search` 返回标题、URL 和片段；参数定义见 [index.ts](../index.ts)，归一化见 [core/validation.ts](../core/validation.ts)。

| 参数 | 说明 |
|---|---|
| `query` | 检索文本 |
| `provider` | 本次主服务：`searxng` 或 `codex-alpha-search`；省略时使用配置，调用覆盖仍沿用配置的回退策略 |
| `max_results` | 本次结果数量；省略时取[配置](configuration.md)中的 `search.maxResults` |
| `domains` | 主机名过滤，例如 `example.com` 包含该域及子域，`*.example.org` 仅包含子域 |
| `recency_days` | 按天请求近期结果，具体时间筛选由服务实现 |

SearXNG 的地址与认证环境变量见[配置](configuration.md)。Codex 使用 Pi 提供的 OAuth（开放授权协议）接口，认证实现见 [auth.ts](../providers/codex/auth.ts)。

搜索结果经[归一化](../shared/results.ts)过滤域名、去重和脱敏后返回；机器输出字段以 [schema.ts](../schema.ts) 为准，Codex 的摘要保存在 `summary`。

搜索输出超限时减少结果并标记 `truncated`；基于搜索回答时附上 `Sources` 来源链接，执行失败时按错误处理。输出边界见 [format.ts](../format.ts)，工具引导见 [index.ts](../index.ts)。

## web_fetch

```json
{ "url": "https://example.com/<path>" }
```

工具获取指定 HTTP(S) URL，将文本保存到临时文件并返回元数据（描述保存文件与来源的信息）；参数定义见 [index.ts](../index.ts)。

| 参数 | 说明 |
|---|---|
| `url` | 要获取的网页或 GitHub 仓库 URL |

已知 URL 时直接调用 `web_fetch`；获取的正文通过返回值中的 `savedContent.path` 交给 `read`（Pi 文件读取工具）。工具引导与输出实现见 [index.ts](../index.ts) 和 [fetch/format.ts](../fetch/format.ts)。

在 codemode（通过 JavaScript 串联工具的调用方式）中：

```js
const fetched = await tools.web_fetch({ url: "https://example.com/<path>" });
text(await tools.read({ path: fetched.savedContent.path, offset: 1 }));
```

| 返回信息 | 用法 |
|---|---|
| `savedContent.path` | 保存文本的路径 |
| `savedContent.bytes` | 保存文本的 UTF-8 字节数 |
| `savedContent.lines` | 按 `read` 编号的行数，末尾换行增加一个空行 |
| `savedContent.maxLineBytes` | 最长行的 UTF-8 字节数，不计换行符 |
| `savedContent.truncated`、`savedContent.truncation` | 保存文本受到的截断及其计量 |
| `savedContent.expiresAt` | 临时文件的到期时间 |
| `url`、`finalUrl` | 处理器报告的最终 URL，经脱敏后两者相同 |
| `source` | 来源：`native-http`、`github-gh`、`github-clone` |
| `repositoryPath` | 浅克隆（只取一层提交历史）的本地仓库路径 |

其他返回字段见 [schema.ts](../schema.ts)，上述计量与 URL 处理见 [fetch/format.ts](../fetch/format.ts)。

完整分析从第 1 行开始，按 `read` 返回的后续偏移继续；定点查询先搜索保存文件，再读取相关范围。每次 `read` 最多返回 2000 行或 50 KiB；最长行超过 50 KiB 时改用 UTF-8 安全的字节分块或结构化处理。`savedContent.truncated` 为真时，继续读取仅覆盖已保存文本。此流程由[读取集成测试](../fetch/read-integration.test.ts)验证。

原生 HTTP 解码响应并提取 HTML 标题；HTML/XHTML、JSON（含 `+json`）与 Markdown 尝试格式化，格式化失败保存解码原文，其他文本保持解码内容。格式选择与实现见 [content.ts](../fetch/content.ts) 和 [formatters/index.ts](../fetch/formatters/index.ts)。

GitHub 仓库 URL 示例：

```text
https://github.com/<owner>/<repo>
https://github.com/<owner>/<repo>/blob/<ref>/<file>
https://github.com/<owner>/<repo>/tree/<ref>/<directory>
```

GitHub 认证由本地 `gh` 命令使用；仓库访问经 GitHub API（程序接口）或浅克隆完成，相关命令见 [gh-client.ts](../fetch/gh-client.ts)。

[配置](configuration.md)中的 `fetch.github.mode` 控制策略：`auto` 查询仓库大小，超过配置阈值走 API，其余优先克隆；`clone` 优先克隆；`api` 走 API；完整提交 SHA（提交对象标识）走 API。克隆失败后按错误类别尝试 API；GitHub 处理器返回空结果时走原生 HTTP，策略见 [github.ts](../fetch/github.ts) 和 [router.ts](../fetch/router.ts)。

分支／标签名中的 `/` 可编码为 `%2F` 明确边界；存在多个引用与路径划分时，通过真实分支和标签确定唯一划分，解析失败或有歧义时走原生 HTTP。实现与测试见 [github-refs.ts](../fetch/github-refs.ts) 和 [github-refs.test.ts](../fetch/github-refs.test.ts)。

仓库根与目录返回结构列表，根目录附带读取到的 README，文件返回文本或二进制描述；克隆结果附带 `repositoryPath`。格式化只影响保存视图，原仓库文件保留原样，见 [github-content.ts](../fetch/github-content.ts) 和[格式化测试](../fetch/github-formatters.test.ts)。

保存文本上限为 50 MiB，原生 HTTP 响应超过该上限时报错；临时文件保留期为 24 小时，启用抓取时在扩展启动阶段清理过期抓取文件，见 [limits.ts](../shared/limits.ts)、[http.ts](../fetch/http.ts) 和 [index.ts](../index.ts)。

抓取内容按外部数据处理；执行仓库代码以用户明确要求为前提，工具引导见 [index.ts](../index.ts)。

## /web-tools status

```text
/web-tools status
```

命令显示启动配置快照中的工具开关、搜索路由、超时、配置来源和认证状态，具体字段见 [commands.ts](../commands.ts)。

## /web-tools test

```text
/web-tools test searxng
/web-tools test codex-alpha-search
```

命令使用固定查询请求一个结果，显示测试结果或分类错误；每次仅测试指定服务。实现见 [commands.ts](../commands.ts)，交互测试见 [commands.test.ts](../commands.test.ts)。

| 参数 | 说明 |
|---|---|
| 服务名 | `searxng`、`codex-alpha-search`；`codex` 是后者别名 |

`search.enabled` 关闭时命令返回禁用提示；配置键见[配置](configuration.md)。
