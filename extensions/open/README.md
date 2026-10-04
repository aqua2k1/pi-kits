# open

## 功能简介

通过 `/open <file|url|directory>` 或模型工具 `open`，用系统默认应用打开文件、URL 和目录。

## 架构

```mermaid
flowchart LR
  A["用户命令 / 模型工具"] --> B["目标校验"]
  B --> C["平台适配"]
  C --> D["系统默认应用"]
```

`index.ts` 注册命令和工具；`../../shared/desktop-open.ts` 处理 macOS、Windows、WSL 和 Linux 的启动差异。

## 配置

在 agent 目录的 `pi-kits.json` 中设置 `open`，修改后执行 `/reload`。以下为默认值：

```json
{
  "open": {
    "enabled": true
  }
}
```

完整字段见[配置示例](../../pi-kits.example.json)。
