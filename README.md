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
| [pi-subagent](extensions/pi-subagent/README.md) | Pi 独立子会话任务、按会话无缝续跑与 Herdr/子进程多宿主执行 |
| [pi-server-tools](extensions/pi-server-tools/README.md) | 为支持的模型自动注入厂商原生服务端工具 |
| [pi-hide-prompts](extensions/pi-hide-prompts/README.md) | 按项目配置隐藏系统提示词 docs 块 |
| [pi-image](extensions/pi-image/README.md) | 接收、预览服务端生成的图片并显式编辑 |

`terminal` 扩展已从主线移除，原实现保留在 `archive/terminal` 分支；`/vim`、`/lg`、`/fm` 不再注册，建议通过 mux 启动相应程序。

`commit` 扩展原实现保留在 `archive/commit` 分支；提交由编码 Agent 执行。

`stats` 扩展原实现保留在 `archive/stats` 分支；`/stats` 不再注册。

`provider-usage` 扩展原实现保留在 `archive/provider-usage` 分支；`/usage` 不再注册。

`notify` 扩展与共享通知库原实现保留在 `archive/notify` 分支；任务结束和问卷开始不再发送桌面通知。

`request-viewer` 扩展原实现保留在 `archive/request-viewer` 分支；`/request-viewer` 不再注册。

## 配置

扩展无全局配置文件，均通过 `pi config` 独立开关。

扩展资源名、包名与目录名一致；工具 namespace 与扩展目录同名：`pi-canvas-note`、`pi-subagent`、`pi-ask`、`pi-open`；工具名称不变。`pi-output-viewer` 使用 `$EDITOR`（默认 `nvim`）；`pi-subagent` 的角色与扩展列表在 Agent Markdown frontmatter 中配置，细节见各包 README。

## 开发

```sh
npm install
npm test
npm run typecheck
npx biome check .
```

检查全部通过后再运行 `npx biome format --write .`。
