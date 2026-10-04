# Workspace extensions

本机工作区工具：终端程序、默认应用启动、会话回复及请求 payload 的只读预览。

## 入口

- `extensions/terminal/index.ts`：`/vim [file]`、`/lg`、`/fm`，分别启动 nvim、lazygit、yazi。
- `extensions/open/index.ts`：`/open <file|url|directory>` 与模型工具 `open`。
- `extensions/preview/index.ts`：`/preview [--thinking]` 选择当前分支回复；`Alt+P` 查看最新回复。
- `extensions/context-preview/index.ts`：`/context-preview [start|stop|status|help]`；默认关闭请求缓存。

根 manifest 和各扩展 manifest 显式列出入口，可独立启用/关闭。`shared/` 中的 terminal-app、readonly-preview、desktop-open 不注册命令或事件。

终端交接及预览需要 TUI 模式；RPC/print 不启动 nvim。临时预览文件权限为 0600，使用完成后清理。默认应用启动与终端交接是两套独立机制，保持原 macOS/Windows/WSL/Linux 平台策略。

## 配置

使用 agent 目录下统一的 `pi-kits.json` 中的顶层 `terminal`、`open`、`preview`、`contextPreview` 设置，各自的 `enabled` 可关闭单项注册；新配置没有组级开关。`terminal.editor`（默认 nvim）、`gitUI`（lazygit）、`fileManager`（yazi）设置直接执行的程序，不是 shell 命令。预览共用 `editor`，要求兼容 `-R` 参数。

```json
{
  "terminal": { "enabled": true, "editor": "nvim" },
  "open": { "enabled": true },
  "preview": { "enabled": true },
  "contextPreview": { "enabled": false }
}
```

旧 `workspace` 段仍兼容读取：顶层设置覆盖同名旧字段，未指定字段保留旧值后再应用默认值。旧 `workspace.enabled: false` 仍关闭其子项，除非子项显式设置顶层 `enabled` 覆盖它。`usage`、`workflow` 旧段遵循相同规则；`web-kits` 内部结构不变。

完整字段见 [配置示例](../pi-kits.example.json)。修改后执行 `/reload`。

## 验证

在仓库根目录安装依赖后：

```sh
npm test
```

试用及迁移步骤见仓库根 README；旧扩展尚在加载时，不要直接叠加新包。
