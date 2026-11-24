# @pi-kits/config

## 功能简介

统一读取、校验和默认化 `pi-kits.json`，并支持保留其他字段的原子更新。

## 架构

```mermaid
flowchart LR
  A["配置文件"] --> B["读取与校验"]
  C["配置契约"] --> B
  B --> D["已知字段解析与默认化"]
  D --> E["扩展配置快照"]
  F["字段更新"] --> G["校验与原子写入"]
  C --> G
  G --> A
```

配置契约统一定义字段校验；配置服务提供路径解析、文件读写和默认值。原始配置保留未知字段，生效配置忽略未知字段。此包不注册 Pi 扩展能力。

## 配置

默认读取 `~/.pi/agent/pi-kits.json`，agent 目录遵循 Pi 的 `PI_CODING_AGENT_DIR`。文件缺失使用默认值；无效或不可读文件报错，修改后 `/reload`。

生效配置仅有五个顶层键：`pi-canvas-note`、`pi-open`、`pi-output-viewer`、`pi-ask`、`pi-subagent`。只读预览编辑器使用 `pi-output-viewer.editor`，默认 `nvim`。旧顶层键、归档扩展键及 `workspace`、`usage`、`workflow` 分组作为未知字段保留但不生效，已有设置须显式迁移到新键。

`pi-token-meter`、`pi-handoff`、`pi-server-tools` 无配置开关，通过 `pi config` 管理加载。完整字段见[配置示例](../../pi-kits.example.json)和 [JSON Schema](../../pi-kits.schema.json)，迁移规则见[配置说明](docs/configuration.md)。
