# pi-kits

将个人 Pi 扩展按职责组织为四个独立 kit 的 npm workspace / Git 仓库。所有包暂为 `private`，不发布 npm；仓库根 Pi manifest 聚合九个入口，支持通过 Git source 整体安装，本地子包路径用于开发和独立试用。

## 包与入口

| 包 | 功能与保留的接口 |
| --- | --- |
| `pi-workspace-kit` | `/vim`、`/lg`、`/fm`、`/open` 与 `open` 工具、`/preview` 与 `Alt+P`、`/context-preview` |
| `pi-usage-kit` | `/usage` 实时余额/限额 widget；`/stats` 历史 token/费用 HTML 报表 |
| `pi-workflow-kit` | `/commit` 与 `--commit`；agent 完成桌面通知 |
| `pi-web-kit` | `web_search`、`web_fetch`；`/web-tools` 诊断命令 |

四个包显式声明九个运行时入口，内部 helper 和测试不会被 Pi 自动加载。Herdr 管理的 `herdr-agent-state.ts` 不在本仓库中，仍由 Herdr 管理。第三方 subagents、Chrome DevTools、ask-user-question 包亦未复制。

## 开发与验证

要求 Node >= 22.19，首次实现验证使用 Node 26.10 / Pi 1.0.0。

```sh
cd ~/Projects/pi-kits
npm ci --ignore-scripts --legacy-peer-deps
npm test
npm run typecheck
npx biome check .
# 只有上一条 check 通过后才执行：
npx biome format --write .
```

Pi 和 TypeBox 等 host 包仅作为 peer / 根开发依赖，不作为 kit 的 runtime dependencies。无需编译即可由 Pi 加载 TypeScript。根测试包括包入口检查及隔离 agent 目录的真实 Pi CLI 加载 smoke test；单元测试使用 fixture，不要求真实搜索服务或 API 凭据。

## 试用：不修改当前配置

**原 `~/.pi/agent/extensions` 全部保留，当前加载配置没有切换。不要直接在正常加载的旧扩展上叠加新 kit。**

启动一次仅加载新 kits 的会话：

```sh
pi --no-extensions \
  -e ~/Projects/pi-kits/packages/workspace-kit \
  -e ~/Projects/pi-kits/packages/usage-kit \
  -e ~/Projects/pi-kits/packages/workflow-kit \
  -e ~/Projects/pi-kits/packages/web-kit
```

`--no-extensions` 同时停用自动发现、已配置和内置扩展，包括当前第三方扩展及 Herdr；显式 `-e` 仍会加载。需要内置 codemode/MCP 时追加 `-e builtin:codemode -e builtin:mcp`，需要其它扩展时显式追加其来源。只试一个 kit 则仅保留对应的 `-e`。

此命令不保存加载配置，但功能仍使用当前 agent 目录中的已有配置和凭据，并可正常产生会话、commit 模型记忆或缓存。桌面/终端功能需要 nvim、lazygit、yazi 或平台 opener 在 PATH 中。

## 以后切换：保留文件，先禁用旧入口

本轮没有执行以下步骤。正式切换时：

1. 用 `pi config` 在个人作用域中禁用旧的九个入口，保留 Herdr。
2. 通过 Git source 安装仓库（实际 URL 在推送远程仓库后提供）：

   ```sh
   pi install "git:<repository-url>"
   ```

   本地开发可使用 `pi install ~/Projects/pi-kits`；也可安装某个 `packages/<name>-kit` 子包，但不要同时启用根包与同功能子包。

3. `/reload`，确认没有重复命令/工具注册及扩展加载错误。
4. 用 `pi config` 独立关闭不需要的入口，例如请求预览或通知。

回滚：移除 Git source 或本地包的加载声明，再重新启用旧入口；无需恢复旧文件。本地 package 加载引用仓库本身，移动仓库后需更新路径。

## 已知限制

此次整合保留了两个原实现的限制，尚未重设计：commit 的生成子进程主要依赖超时终止，尚无贯穿 session shutdown 的取消接口；WSL 通知适配器尚未将 Linux 脚本路径转换为 Windows 路径，可能静默失败。桌面通知属于 best-effort 功能。后续可分别补充取消协议和 WSL 路径转换测试。

## 迁移边界

- workspace 将终端交接、临时只读预览、桌面打开拆为纯 helper。helper 不注册 Pi 功能。
- workflow 的 commit 依赖纯通知 API，不导入 notify 扩展入口；agent 完成通知可独立关闭。
- usage 保留实时远端用量与本地历史统计两条独立流程。stats 的平台浏览器启动逻辑暂保留，不引入跨 kit 运行时依赖。
- web 保留原模块层次、工具/命令名称以及 `web-tools-config.json` / 缓存路径，主要调整包名与维护位置。
- commit 的模型记忆仍位于 agent 目录下 `extensions/commit/last_model.json`，不把个人运行数据复制进 Git。
- context-preview 默认不缓存请求；临时预览文件权限为 0600，退出或启动失败后清理。不将请求 payload 写入会话。

迁移修正了 context-preview 无参数处理、ChatGPT plan_type 的 nullable 访问，并适配了 Pi 1.0 的测试工具上下文。此外，provider-usage 在等待认证后重新验证数据源与 generation，避免 shutdown 后请求或将旧 provider token 发给新数据源；桌面 opener 捕获异步 spawn 错误，避免缺少可执行程序时未处理 ENOENT。均仅修改新 kit，并添加回归测试；其余业务行为尽量保持原状。
