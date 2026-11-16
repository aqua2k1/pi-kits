# pi-kits

为 [Pi](https://pi.dev) 提供工作区工具、交互问答、会话交接工作流、用量统计、Web 工具和 Gruvbox 主题。

## 安装

```sh
pi install https://github.com/aqua2k1/pi-kits.git
```

需要 Pi 和 Node.js ≥ 22.19。通过 `pi config` 选择扩展，在 `/settings` 中选择 `gruvbox` 主题。

## 扩展

| 扩展 | 功能 |
| --- | --- |
| [pi-canvas-note](extensions/pi-canvas-note/README.md) | 浏览器纸张式文档、图表公式和多选回复 |
| [pi-open](extensions/pi-open/README.md) | 用默认应用打开文件、URL 和目录 |
| [pi-output-viewer](extensions/pi-output-viewer/README.md) | 只读预览会话回复 |
| [pi-token-meter](extensions/pi-token-meter/README.md) | 编辑器下方信息行显示最近请求的 TTFT 和 TPS |
| [pi-handoff](extensions/pi-handoff/README.md) | 克隆会话并生成交接摘要 |
| [pi-ask](extensions/pi-ask/README.md) | 单选、多选和自定义回答 |
| [pi-subagent](extensions/pi-subagent/README.md) | Pi/Codex 独立任务与原生终端视图；在 Herdr 内按环境自动启用 |
| [pi-web-kits](extensions/pi-web-kits/README.md) | Web 搜索、网页与 GitHub 内容获取 |

`terminal` 扩展已从主线移除，原实现保留在 `archive/terminal` 分支；`/vim`、`/lg`、`/fm` 不再注册，建议通过 mux 启动相应程序。

`commit` 扩展原实现保留在 `archive/commit` 分支；提交由编码 Agent 执行。

`stats` 扩展原实现保留在 `archive/stats` 分支；`/stats` 不再注册。

`provider-usage` 扩展原实现保留在 `archive/provider-usage` 分支；`/usage` 不再注册。

`notify` 扩展与共享通知库原实现保留在 `archive/notify` 分支；任务结束和问卷开始不再发送桌面通知。

`request-viewer` 扩展原实现保留在 `archive/request-viewer` 分支；`/request-viewer` 不再注册。

## 配置

配置文件为 agent 目录下的 `pi-kits.json`，默认位于 `~/.pi/agent/`，可由 `PI_CODING_AGENT_DIR` 调整。修改后执行 `/reload`。

扩展资源名、包名与目录名一致；`extensionAllowlist[].extensions` 填写 `pi-web-kits`、`pi-ask` 等完整名称。生效的配置顶层键仅有 `pi-canvas-note`、`pi-open`、`pi-output-viewer`、`pi-ask`、`pi-subagent`、`pi-web-kits`；工具、命令与 namespace 名称不变。

`pi-output-viewer.editor` 设置只读预览编辑器，默认 `nvim`。旧顶层键、归档扩展键及旧分组仅作为未知字段保留在原始配置中，生效配置忽略它们；已有设置须显式迁移到新键，见[共享配置](shared/config/docs/configuration.md)。

扩展可通过 `pi config` 独立关闭；提供 `enabled` 配置的扩展也可在配置文件中关闭。`pi-token-meter`、`pi-handoff` 无配置开关。完整字段见[配置示例](pi-kits.example.json)和 [JSON Schema](pi-kits.schema.json)；架构与使用细节见各包 README。

## 开发

```sh
npm install
npm test
npm run typecheck
npx biome check .
```

检查全部通过后再运行 `npx biome format --write .`。
