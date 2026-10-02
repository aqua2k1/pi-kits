# pi-workspace-kit

本机工作区工具：终端程序、默认应用启动、会话回复及请求 payload 的只读预览。

## 入口

- `src/extensions/terminal.ts`：`/vim [file]`、`/lg`、`/fm`，分别启动 nvim、lazygit、yazi。
- `src/extensions/open.ts`：`/open <file|url|directory>` 与模型工具 `open`。
- `src/extensions/preview.ts`：`/preview [--thinking]` 选择当前分支回复；`Alt+P` 查看最新回复。
- `src/extensions/context-preview.ts`：`/context-preview [start|stop|status|help]`；默认关闭请求缓存。

Pi manifest 显式列出四个入口，可独立启用/关闭。`src/lib` 中的 terminal-app、readonly-preview、desktop-open 不注册命令或事件。

终端交接及预览需要 TUI 模式；RPC/print 不启动 nvim。临时预览文件权限为 0600，使用完成后清理。默认应用启动与终端交接是两套独立机制，保持原 macOS/Windows/WSL/Linux 平台策略。

## 验证

在仓库根目录安装依赖后：

```sh
npm test --workspace pi-workspace-kit
```

试用及迁移步骤见仓库根 README；旧扩展尚在加载时，不要直接叠加新包。
