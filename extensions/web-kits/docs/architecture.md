# 架构

[index.ts](../index.ts) 读取启动配置快照并注册工具与诊断命令，[composition.ts](../composition.ts) 按需组装搜索服务和抓取路由；搜索与抓取各自处理认证、超时及错误分类。共享配置与 UI（界面）能力分别见[配置服务](../../../shared/config/README.md)和[共享 UI](../../../shared/docs/ui.md)。

## 模块关系

```mermaid
flowchart LR
  entry["index.ts<br/>注册与启动快照"] --> config["config.ts<br/>配置解析"]
  entry --> commands["commands.ts<br/>诊断命令"]
  entry --> composition["composition.ts<br/>组装搜索与抓取"]
  commands --> composition
  composition --> search["core/router.ts<br/>搜索主备路由"]
  composition --> fetch["fetch/router.ts<br/>抓取路由"]
  search --> providers["providers/<br/>认证与搜索请求"]
  fetch --> handlers["fetch/http.ts 与 fetch/github.ts<br/>HTTP 与仓库内容获取"]
  entry --> output["schema.ts 与两份 format.ts<br/>输出契约与预算"]
```

## 文件地图

| 文件 | 职责 |
|---|---|
| `index.ts` | 工具注册、参数 schema（结构契约）、启动快照、进度及错误边界 |
| `commands.ts` | 状态展示、搜索服务连接测试及参数补全 |
| `composition.ts` | 具体搜索服务工厂与抓取入口组装 |
| `config.ts` | 扩展配置读取、服务名归一化、搜索与抓取配置解析 |
| `schema.ts` | 公开机器输出及派生类型 |
| `format.ts`、`renderers.ts` | 搜索文本／机器输出与工具界面渲染 |
| `core/types.ts`、`core/validation.ts` | 搜索内部契约及请求归一化 |
| `core/router.ts`、`core/routing.ts`、`core/errors.ts` | 主备搜索路由、回退选择与分类错误 |
| `providers/searxng/config.ts`、`providers/searxng/provider.ts` | SearXNG 地址、认证和搜索请求转换 |
| `providers/codex/config.ts`、`providers/codex/auth.ts`、`providers/codex/provider.ts` | Codex 模型配置、Pi 认证及搜索请求转换 |
| `shared/http.ts`、`shared/results.ts`、`shared/limits.ts` | 扩展内的搜索传输、结果归一化和资源边界 |
| `fetch/router.ts`、`fetch/types.ts` | 抓取请求解析、处理器选择及运行时能力 |
| `fetch/http.ts`、`fetch/content.ts` | 原生 HTTP 流读取、解码和标题提取 |
| `fetch/formatters/index.ts`、`fetch/formatters/prettier-worker.mjs` | 按 MIME（媒体类型）／文件名选择格式化器及独立工作线程 |
| `fetch/github-url.ts`、`fetch/github-refs.ts` | GitHub URL 和引用／路径边界解析 |
| `fetch/github.ts`、`fetch/github-content.ts` | API／克隆策略、克隆缓存与仓库内容生成 |
| `fetch/gh-client.ts`、`fetch/command.ts` | GitHub 命令参数与有界子进程执行 |
| `fetch/spool.ts`、`fetch/format.ts`、`fetch/errors.ts` | 临时存储、公开元数据与抓取分类错误 |

## 数据流

### 搜索

```mermaid
sequenceDiagram
  actor caller as 调用方
  participant entry as index.ts
  participant router as core/router.ts
  participant provider as 搜索服务适配器
  participant transport as shared/http.ts
  participant results as shared/results.ts
  participant output as format.ts
  caller->>entry: web_search 参数
  entry->>router: 通过 composition.ts 传入请求与配置
  router->>provider: 归一化请求并构造主服务
  provider->>transport: 认证后发送请求并读取 JSON
  transport-->>provider: 响应数据
  provider->>results: 过滤、去重、脱敏与限长
  results-->>provider: 安全搜索响应
  provider-->>router: 搜索响应
  router-->>entry: 响应与实际服务名
  entry->>output: 构造文本、详情和机器输出
  output-->>caller: 搜索结果
```

符合分类策略的失败按配置尝试备用服务；取消结束调用，空结果直接返回。

### 抓取

```mermaid
sequenceDiagram
  actor caller as 调用方
  participant entry as index.ts
  participant router as fetch/router.ts
  participant handler as HTTP 或 GitHub 处理器
  participant formatter as fetch/formatters/index.ts
  participant spool as fetch/spool.ts
  participant output as fetch/format.ts
  caller->>entry: web_fetch URL
  entry->>router: 通过 composition.ts 传入请求与配置
  router->>handler: 校验 URL 并选择处理器
  handler->>formatter: 解码文本或仓库文本视图
  formatter-->>handler: 格式化文本或原文
  handler->>spool: 保存有界 UTF-8 文本
  spool-->>handler: 保存路径与有界文本
  handler-->>router: 响应与截断计量
  router-->>entry: 抓取响应
  entry->>output: 计算最终文本布局并构造元数据
  output-->>caller: 保存路径与布局元数据
  caller->>caller: 用 read 分页读取保存文件
```

GitHub 处理器返回空结果时转原生 HTTP；HTTP 原始响应先流式写入临时文件，保存文本后移除中间文件；失败清理临时文件。

## 约束

- `index.ts` 将同一文件与环境快照交给工具和诊断命令，保持状态展示与实际请求一致；`index.test.ts` 和 `commands.test.ts` 检查启动后读取次数。
- `composition.ts` 负责具体服务组装，`core/router.ts` 仅调用工厂与路由，保证未使用的服务不会触发认证或配置检查；`composition.test.ts` 覆盖惰性构造与凭据隔离。
- 搜索路由保留服务返回的脱敏查询，防止原始输入覆盖清理结果；`core/router.test.ts` 检查返回查询，`composition.test.ts` 检查回退中的凭据反射。
- 搜索回退使用 `core/errors.ts` 的分类策略并在尝试间检查取消信号，避免无效请求或用户取消继续调用备用服务；`core/router.test.ts` 覆盖这些分支。
- Codex 从 Pi 认证接口获取 OAuth 凭据并使用固定搜索端点，避免把其他来源的请求地址和头部混入请求；`providers/codex/auth.test.ts` 和 `composition.test.ts` 检查此边界。
- 搜索传输的单次截止时间覆盖认证、请求与响应流，且重定向采用报错策略，避免认证结束过晚仍发请求或重定向转发凭据；`shared/http.test.ts`、Codex 服务测试与 SearXNG 重定向测试覆盖该行为。
- `schema.ts` 派生公开输出和相关内部类型，注册处引用同一输出契约，防止机器字段与类型分歧；`index.test.ts` 对返回值执行 schema 检查。
- 两个输出格式器以完整序列化返回值计算预算，计入文本、详情和机器数据副本，避免单份内容合规而总返回值超限；边界见 `shared/limits.ts`，测试见两份 `format.test.ts`。
- 抓取格式器仅公开保存元数据，布局基于最终文本计算，使 `read` 的偏移与返回行数一致；`fetch/format.test.ts` 和 `fetch/read-integration.test.ts` 覆盖空行、UTF-8 与分页。
- 格式化在线程中使用固定选项和资源预算，失败返回输入；调用方在保存前检查取消，避免阻塞主线程或将已取消请求当作成功保存；实现见 `fetch/formatters/`、`fetch/http.ts` 与 `fetch/github.ts`。
- `fetch/spool.ts` 串行写入并在写前预留容量，最终化后拒绝重复保存，保证并发写入与短写处理仍满足存储边界；`fetch/spool.test.ts` 覆盖状态和容量竞争。
- GitHub 引用解析只接受唯一分支／标签划分，避免把含 `/` 的引用误当目录；`fetch/github-refs.test.ts` 和 `fetch/github-url.test.ts` 覆盖歧义与显式编码。
- 克隆操作由调用方运行时中的处理器缓存持有，每个操作使用独立临时目录，避免不同处理器和失败重试覆盖已有仓库；`fetch/router.test.ts` 与 `fetch/github-isolation.test.ts` 覆盖隔离。
- 同一克隆的等待者独立取消，最后一个等待者退出才中止克隆；创建前预留会话容量，避免单个调用取消影响其他调用或并发突破容量；`fetch/github.test.ts` 覆盖这两项。
- 仓库内容访问同时校验解析路径和真实路径，防止目录遍历或符号链接读取仓库外文件；`fetch/github-content.test.ts` 覆盖路径逃逸。
- `fetch/gh-client.ts` 固定 GitHub 主机并以参数数组调用 `gh`／`git`，`fetch/command.ts` 关闭 shell，避免命令解析改变主机或参数含义；相关客户端与进程测试覆盖参数和终止流程。
- 工具与诊断边界重建分类错误消息，避免上游正文、凭据和原始子进程诊断进入返回值；依据见两份 `errors.ts` 及 `commands.test.ts`、`index.test.ts`。

## 测试

在仓库根目录运行[包脚本](../package.json)：

```sh
npm test --workspace=web-kits
npm run typecheck --workspace=web-kits
```

| 测试文件（相对扩展目录） | 覆盖模块 |
|---|---|
| `index.test.ts`、`commands.test.ts`、`composition.test.ts`、`config.test.ts` | 工具注册、启动快照、开关、参数、命令、服务组装与配置 |
| `format.test.ts`、`fetch/format.test.ts` | 文本／机器契约、脱敏、布局与完整输出预算 |
| `core/{errors,router,routing,validation}.test.ts` | 搜索分类、回退、取消和归一化 |
| `shared/{http,results}.test.ts` | 搜索流边界、截止时间、重定向、过滤和脱敏 |
| `providers/codex/{auth,provider}.test.ts` | OAuth、固定端点、请求结构与取消 |
| `providers/searxng/{provider,redirect}.test.ts` | 地址配置、搜索参数及真实 HTTP 重定向 |
| `fetch/{command,content,errors,http,router,spool}.test.ts` | 进程、解码、抓取分类、传输、处理器隔离及存储状态 |
| `fetch/formatters.test.ts`、`fetch/github-formatters.test.ts` | 格式选择、工作线程、取消与 GitHub 保存视图 |
| `fetch/github.test.ts`、`fetch/github-isolation.test.ts` | 策略、并发克隆、取消、容量与隔离 |
| `fetch/{gh-client,github-content,github-readme,github-refs,github-url}.test.ts` | 命令、路径访问、README 边界及引用解析 |
| `fetch/read-integration.test.ts` | 本地 HTTP 与 Pi `read` 的实际分页；`PI_KITS_LIVE_FETCH=1` 启用外网用例 |
| `fetch/model-read.test.ts` | `PI_KITS_MODEL_READ=1` 启用真实模型会话，检查完整审查与定点查询 |

手动模型实验的夹具、参数和报告见[实验方法](notes/2026-10-07-read-ab-test.md)。
