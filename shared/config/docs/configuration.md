# 配置与更新

配置由 `@pi-kits/config` 统一校验及默认化。扩展加载时读取快照，修改后通过 `/reload` 生效。缺失文件或字段使用默认值；格式错误、字段不合法或文件不可读均报错，不静默回退。

配置的各层对象允许未知字段；未知字段保留在原始配置中，但不进入生效配置。已知字段仍校验类型、范围和枚举，拼错的字段名也作为未知字段忽略。

`pi-subagent.enabled` 默认为 `true`，终端适配器由扩展按环境自动选择。`pi-token-meter`、`pi-handoff`、`pi-server-tools` 无配置开关，通过 `pi config` 管理加载。

## 配置键与迁移

生效配置只包含五个与扩展目录同名的顶层键：`pi-canvas-note`、`pi-open`、`pi-output-viewer`、`pi-ask`、`pi-subagent`。原始配置（raw）保留未知字段，生效配置（resolved）只读取这五个键，不提供旧顶层键的别名。

旧键作为未知字段保留在 raw 中，但在 resolved 中被忽略、不生效；须将需要的设置迁移到以下新键：

| 旧配置位置 | 迁移目标 |
|---|---|
| `canvas-note` | `pi-canvas-note` |
| `open` | `pi-open` |
| `preview` | `pi-output-viewer` |
| `askUserQuestion` | `pi-ask` |
| `subagent` | `pi-subagent` |
| `terminal.editor` | `pi-output-viewer.editor` |

旧 `workspace`、`usage`、`workflow` 分组同样作为未知字段忽略；须把其中仍需使用的扩展设置移到对应的新顶层键。旧分组的 `enabled` 不控制扩展，关闭扩展时在新键下显式设置 `enabled: false`。

归档及移除配置项的旧键（如 `terminal`、`commit`、`stats`、`providerUsage`、`notify`、`contextPreview`、`web-kits`、`pi-web-kits`）仅作为未知字段留在 raw 中，不进入 resolved。`pi-subagent.mux` 也作为未知字段忽略，终端适配器按环境自动选择。

配置键迁移与工具 namespace 独立：工具 namespace 与扩展目录同名，使用 `pi-canvas-note`、`pi-subagent`、`pi-ask`、`pi-open`；工具名称和运行时事件名称不变。

## 写入

`updatePiKitsConfig` 读取原始配置，对修改结果重新校验，然后以原子替换方式写入，保留未修改字段，包括未知字段；保留旧键不使其生效。

[配置示例](../../../pi-kits.example.json)和 [JSON Schema](../../../pi-kits.schema.json)位于仓库根目录。
