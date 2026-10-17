# 架构

[index.ts](../index.ts) 读取启动配置快照并注册工具与诊断命令，[composition.ts](../composition.ts) 按需组装搜索服务和抓取路由；搜索与抓取各自处理认证、超时及错误分类。共享配置与 UI（界面）能力分别见[配置服务](../../../shared/config/README.md)和[共享 UI](../../../shared/docs/ui.md)。

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
| `providers/searxng/config.ts`、`provider.ts` | SearXNG 地址、认证和搜索请求转换 |
| `providers/codex/config.ts`、`auth.ts`、`provider.ts` | Codex 模型配置、Pi 认证及搜索请求转换 |
| `shared/http.ts`、`shared/results.ts`、`shared/limits.ts` | 扩展内的搜索传输、结果归一化和资源边界 |
| `fetch/router.ts`、`fetch/types.ts` | 抓取请求解析、处理器选择及运行时能力 |
| `fetch/http.ts`、`fetch/content.ts` | 原生 HTTP 流读取、解码和标题提取 |
| `fetch/formatters/index.ts`、`prettier-worker.mjs` | 按 MIME（媒体类型）／文件名选择格式化器及独立工作线程 |
| `fetch/github-url.ts`、`fetch/github-refs.ts` | GitHub URL 和引用／路径边界解析 |
| `fetch/github.ts`、`fetch/github-content.ts` | API／克隆策略、克隆缓存与仓库内容生成 |
| `fetch/gh-client.ts`、`fetch/command.ts` | GitHub 命令参数与有界子进程执行 |
| `fetch/spool.ts`、`fetch/format.ts`、`fetch/errors.ts` | 临时存储、公开元数据与抓取分类错误 |
| `package.json` | Pi 入口、依赖和测试脚本 |

## 数据流

1. `index.ts` 读取并解析文件与环境变量，按[配置开关](configuration.md)注册工具、命令及执行临时文件清理。
2. 搜索请求经 `core/validation.ts` 归一化，`core/router.ts` 按主备顺序惰性构造服务；`composition.ts` 注入各自的认证与传输。
3. 搜索服务经 `shared/http.ts` 读取响应，`shared/results.ts` 统一过滤、去重与脱敏，`format.ts` 生成文本、界面详情及机器输出。
4. 抓取请求经 `fetch/router.ts` 解析后先交给 GitHub 处理器；处理器返回空结果时转原生 HTTP，具体策略见[使用](usage.md#web_fetch)。
5. HTTP 流写入临时 `response.bin`，解码与格式化后保存 `content.txt` 并移除中间文件；GitHub 内容经格式化／仓库视图生成后直接保存文本。
6. `fetch/format.ts` 从最终保存文本计算布局并生成元数据；`index.ts` 返回工具结果，调用方按[读取流程](usage.md#web_fetch)访问保存文件。

## 约束

- `index.ts` 将同一文件与环境快照交给工具和诊断命令，保持状态展示与实际请求一致；`index.test.ts` 和 `commands.test.ts` 检查启动后读取次数。
- `composition.ts` 负责具体服务组装，`core/router.ts` 仅调用工厂与路由，保证未使用的服务不会触发认证或配置检查；`composition.test.ts` 覆盖惰性构造与凭据隔离。
- 搜索路由保留服务返回的脱敏查询，防止原始输入覆盖清理结果；`core/router.test.ts` 检查返回查询，`composition.test.ts` 检查回退中的凭据反射。
- 搜索回退使用 `core/errors.ts` 的分类策略并在尝试间检查取消信号，避免无效请求或用户取消继续调用备用服务；`core/router.test.ts` 覆盖这些分支。
- Codex 从 Pi 认证接口获取 OAuth 凭据并使用固定搜索端点，避免把其他来源的请求地址和头部混入请求；`providers/codex/auth.test.ts` 和 `composition.test.ts` 检查此边界。
- 搜索传输的单次截止时间覆盖认证、请求与响应流，且重定向采用报错策略，避免认证结束过晚仍发请求或重定向转发凭据；`shared/http.test.ts`、Codex 服务测试与 SearXNG 重定向测试覆盖该行为。
- `schema.ts` 同时派生公开输出与内部相关类型，枚举使用 Pi 的 `StringEnum`，保持注册 schema 和实际机器输出一致；`index.test.ts` 对返回值执行 schema 检查。
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
| `fetch/read-integration.test.ts` | 本地 HTTP 与 Pi `read` 的实际分页；外网用例通过文件内环境开关启用 |
| `fetch/model-read.test.ts` | 通过文件内环境开关启用真实模型会话，验证完整审查与定点查询 |
