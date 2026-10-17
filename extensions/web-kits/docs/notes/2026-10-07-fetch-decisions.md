# 抓取传输与保存边界的决策

日期：2026-10-07（原记录的 Git 提交日期）
结论：抓取以原生 HTTP 和 GitHub 专用处理器获取内容，再通过有界临时文件交付文本；实现见[抓取路由](../../fetch/router.ts)。

## 过程与数据

[HTTP 传输](../../fetch/http.ts)把取消信号、响应流读取与超时放在一次请求流程中；[传输测试](../../fetch/http.test.ts)检查超时、取消、响应大小和临时文件结果。

[GitHub 处理器](../../fetch/github.ts)按配置、引用及仓库大小选择 API 或浅克隆，克隆失败后按错误类别尝试 API；[策略测试](../../fetch/github.test.ts)覆盖小仓库克隆、大仓库 API、并发等待与取消。

[命令客户端](../../fetch/gh-client.ts)负责 GitHub 命令参数，[进程执行器](../../fetch/command.ts)负责超时、输出边界和终止，使仓库内容生成复用统一的命令结果。

[保存层](../../fetch/spool.ts)限制最终文本并在 UTF-8 字符边界截断，[输出层](../../fetch/format.ts)返回保存路径和布局元数据；[读取集成测试](../../fetch/read-integration.test.ts)通过真实 HTTP 与 Pi 文件读取工具核对分页后的文本。
