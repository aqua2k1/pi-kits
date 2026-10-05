# pi-kits

为 [Pi](https://pi.dev) 提供工作区工具、交互问答、提交工作流、用量统计、Web 工具和 Gruvbox 主题。

## 安装

```sh
pi install https://github.com/aqua2k1/pi-kits.git
```

需要 Pi 和 Node.js ≥ 22.19。通过 `pi config` 选择扩展，在 `/settings` 中选择 `gruvbox` 主题。

## 扩展

| 扩展 | 功能 |
| --- | --- |
| [terminal](extensions/terminal/README.md) | 打开编辑器、Git 界面和文件管理器 |
| [open](extensions/open/README.md) | 用默认应用打开文件、URL 和目录 |
| [preview](extensions/preview/README.md) | 只读预览会话回复 |
| [context-preview](extensions/context-preview/README.md) | 查看模型请求 payload |
| [provider-usage](extensions/provider-usage/README.md) | 显示服务商余额与额度 |
| [stats](extensions/stats/README.md) | 生成 Token 和费用统计报告 |
| [commit](extensions/commit/README.md) | 生成并确认 Conventional Commits 提交 |
| [notify](extensions/notify/README.md) | 任务完成桌面通知 |
| [ask-user-question](extensions/ask-user-question/README.md) | 单选、多选和自定义回答 |
| [subagent](extensions/subagent/README.md) | Pi/Codex 独立任务与原生终端视图；须配置 Herdr mux 并在 Herdr 内运行 |
| [web-kits](extensions/web-kits/README.md) | Web 搜索、网页与 GitHub 内容获取 |

## 配置

配置文件为 agent 目录下的 `pi-kits.json`，默认位于 `~/.pi/agent/`，可由 `PI_CODING_AGENT_DIR` 调整。修改后执行 `/reload`。

各扩展可通过 `enabled` 独立关闭。完整字段见[配置示例](pi-kits.example.json)和 [JSON Schema](pi-kits.schema.json)；架构与使用细节见各包 README。

## 开发

```sh
npm install
npm test
npm run typecheck
npx biome check .
```

检查全部通过后再运行 `npx biome format --write .`。
