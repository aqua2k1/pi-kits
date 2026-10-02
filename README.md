# pi-kits

## 简介

为 [Pi](https://pi.dev) 提供工作区工具、用量统计、提交工作流和 Web 搜索/抓取能力的扩展集合。按职责拆分为四个独立 kit，可分别安装，并按需启用其中的功能。

目前以本地包形式使用，尚未发布到 npm。

## 功能

| Kit | 包含功能 |
| --- | --- |
| **workspace-kit** | `/vim` 打开 nvim、`/lg` 启动 lazygit、`/fm` 启动 yazi；`/open` 和 `open` 工具使用默认应用打开文件/URL；`/preview` 和 `Alt+P` 只读查看回复；`/context-preview` 查看请求 payload，默认不缓存 |
| **usage-kit** | `/usage` 刷新 provider 余额/限额 widget，支持 DeepSeek 和 ChatGPT；`/stats` 生成历史 token/费用 HTML 报表 |
| **workflow-kit** | `/commit` 和 `--commit` 生成并确认 Conventional Commit；agent 完成后发送桌面通知 |
| **web-kit** | `web_search` 搜索、`web_fetch` 抓取网页与 GitHub 内容；`/web-tools` 查看状态和诊断服务 |

各 kit 使用显式入口，预览、通知、实时用量等功能可独立开关。Herdr 集成和第三方 subagents、Chrome DevTools、ask-user-question 不包含在此仓库中。

## Requirements & Install

### Requirements

- **Node.js >= 22.19**、npm，以及已安装的 **Pi**。当前验证版本为 Pi 1.0.0。
- 按使用的功能安装 **nvim**、**lazygit**、**yazi**、**Git**；GitHub 抓取模式可能需要 **gh**。
- 默认应用打开及桌面通知需要平台对应的程序和桌面环境。
- 实时用量需要对应 provider 的凭据；Web 搜索需要配置 SearXNG 或 Codex 数据源，详见 [web-kit](packages/web-kit/README.md)。
- 终端交接与只读预览需要 Pi 的交互式 TUI 模式。

### Install

```sh
cd ~/Projects/pi-kits
npm ci --ignore-scripts --legacy-peer-deps
```

安装需要的 kit，以下本地包名对应 `pi-workspace-kit`、`pi-usage-kit`、`pi-workflow-kit` 和 `pi-web-kit`：

```sh
pi install ~/Projects/pi-kits/packages/workspace-kit
pi install ~/Projects/pi-kits/packages/usage-kit
pi install ~/Projects/pi-kits/packages/workflow-kit
pi install ~/Projects/pi-kits/packages/web-kit
```

**已有旧扩展时，先通过 `pi config` 禁用对应旧入口，再安装新 kit；无需删除旧文件。** 本次迁移没有修改当前加载配置。安装后使用 `/reload`，也可通过 `pi config` 调整各入口的开关。

只想试用、不保存加载配置：

```sh
pi --no-extensions \
  -e ~/Projects/pi-kits/packages/workspace-kit \
  -e ~/Projects/pi-kits/packages/usage-kit \
  -e ~/Projects/pi-kits/packages/workflow-kit \
  -e ~/Projects/pi-kits/packages/web-kit
```

`--no-extensions` 会停用其它自动加载的扩展（含内置扩展），仅保留显式 `-e` 指定的包。可删掉不需要的 kit，或追加 `-e builtin:codemode -e builtin:mcp`。

开发验证和迁移/回滚细节见 [开发说明](docs/development.md)。
