# pi-kits

## 简介

为 [Pi](https://pi.dev) 提供工作区工具、用量统计、提交工作流和 Web 搜索/抓取能力的扩展集合。通过一个 Git 仓库安装，内部按职责拆分为四个 kit，可按需启用功能。

## 功能

| Kit | 包含功能 |
| --- | --- |
| **workspace-kit** | `/vim` 打开 [nvim](https://neovim.io/)、`/lg` 启动 [lazygit](https://github.com/jesseduffield/lazygit)、`/fm` 启动 [yazi](https://yazi-rs.github.io/)；`/open` 和 `open` 工具使用默认应用打开文件/URL；`/preview` 和 `Alt+P` 只读查看回复；`/context-preview` 查看请求 payload，默认不缓存 |
| **usage-kit** | `/usage` 刷新 provider 余额/限额 widget，支持 DeepSeek 和 ChatGPT；`/stats` 生成历史 token/费用 HTML 报表 |
| **workflow-kit** | `/commit` 和 `--commit` 生成并确认 Conventional Commit；agent 完成后发送桌面通知 |
| **web-kit** | `web_search` 搜索、`web_fetch` 抓取网页与 GitHub 内容；`/web-tools` 查看状态和诊断服务 |

仓库显式声明九个功能入口，可通过 `pi config` 独立开关。Herdr 集成和第三方 subagents、Chrome DevTools、ask-user-question 不包含在此仓库中。

## Requirements & Install

### Requirements

- [Node.js](https://nodejs.org/) **>= 22.19**、[npm](https://www.npmjs.com/)、[Git](https://git-scm.com/)，以及已安装的 [Pi](https://pi.dev)。当前验证版本为 Pi 1.0.0。
- 按使用的功能安装 [nvim](https://neovim.io/)、[lazygit](https://github.com/jesseduffield/lazygit)、[yazi](https://yazi-rs.github.io/)；GitHub 抓取模式可能需要 [gh](https://cli.github.com/)。
- 默认应用打开及桌面通知需要平台对应的程序和桌面环境。
- 实时用量需要对应 provider 的凭据；Web 搜索需要配置 [SearXNG](https://github.com/searxng/searxng) 或 [Codex](https://github.com/openai/codex) 数据源，详见 [web-kit](packages/web-kit/README.md)。
- 终端交接与只读预览需要 Pi 的交互式 TUI 模式。

### Install

通过 Git 仓库安装全部 kit：

```sh
pi install https://github.com/aqua2k1/pi-kits.git
```
