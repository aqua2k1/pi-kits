# 配置与更新

配置由 `@pi-kits/config` 统一校验及默认化。扩展加载时读取快照，修改后通过 `/reload` 生效。缺失文件或字段使用默认值；格式错误、字段不合法或文件不可读均报错，不静默回退。

配置的各层对象允许未知字段；未知字段保留在原始配置中，但不进入生效配置。已知字段仍校验类型、范围和枚举，拼错的字段名也作为未知字段忽略。

`pi-web-kits.fetch.github` 仅保留 `enabled`（默认 `true`）；旧 `mode`、`maxRepoSizeMB`、`cloneTimeoutSeconds`、`clonePath` 作为未知字段忽略，包括类型无效的旧值。

`pi-subagent.enabled` 默认为 `true`，终端适配器由扩展按环境自动选择。`pi-token-meter`、`pi-handoff` 无配置开关，通过 `pi config` 管理加载。

## 配置键与迁移

生效配置只包含六个与扩展目录同名的顶层键：`pi-canvas-note`、`pi-open`、`pi-output-viewer`、`pi-ask`、`pi-subagent`、`pi-web-kits`。原始配置（raw）保留未知字段，生效配置（resolved）只读取这六个键，不提供旧顶层键的别名。

旧键作为未知字段保留在 raw 中，但在 resolved 中被忽略、不生效；须将需要的设置迁移到以下新键：

| 旧配置位置 | 迁移目标 |
|---|---|
| `canvas-note` | `pi-canvas-note` |
| `open` | `pi-open` |
| `preview` | `pi-output-viewer` |
| `askUserQuestion` | `pi-ask` |
| `subagent` | `pi-subagent` |
| `web-kits` | `pi-web-kits` |
| `terminal.editor` | `pi-output-viewer.editor` |

旧 `workspace`、`usage`、`workflow` 分组同样作为未知字段忽略；须把其中仍需使用的扩展设置移到对应的新顶层键。旧分组的 `enabled` 不控制扩展，关闭扩展时在新键下显式设置 `enabled: false`。

归档扩展的旧键（如 `terminal`、`commit`、`stats`、`providerUsage`、`notify`、`contextPreview`）仅作为未知字段留在 raw 中，不进入 resolved。`pi-subagent.mux` 也作为未知字段忽略，终端适配器按环境自动选择。

配置键迁移与工具 namespace 独立：工具 namespace 与扩展目录同名，使用 `pi-canvas-note`、`pi-subagent`、`pi-web-kits`、`pi-ask`、`pi-open`；工具名称和运行时事件名称不变。

## 旧搜索字段兼容

`pi-web-kits.search.routing` 和 `pi-web-kits.search.codex` 继续兼容；当前配置使用 `pi-web-kits.search.sources.web`，两种网页配置不能混用。这是 `pi-web-kits` 内部搜索布局的兼容，与已忽略的旧顶层 `web-kits` 键无关。

| 旧字段（相对 `pi-web-kits`） | 类型 | 默认值 | 兼容行为 |
|---|---|---|---|
| `search.routing.provider` | string | `searxng` | `searxng`、`codex-alpha-search`、`codex`；`codex` 是后者别名 |
| `search.routing.fallback` | boolean | `false` | 转换为网页路由是否含第二项 |
| `search.routing.fallbackProvider` | string | 未设置；启用回退时选择另一服务 | 枚举同旧主服务；归一化别名后须与主服务不同；关闭回退时无备用 |
| `search.codex.model` | string | `gpt-6-luna` | 1–128 字符，仅字母、数字、点、下划线和连字符；转换为网页 Codex 模型 |

## 搜索能力配置

`pi-web-kits.search` 的公共设置为 `enabled`（默认 `true`）、`maxResults`（默认 5，1–10）和 `timeoutMs`（默认 15000，1000–120000）。

- `sources.web.enabled` 默认 `true`；`sources.web.routing` 默认 `["searxng"]`，可按顺序填写 `searxng`、`codex-alpha-search`，1–2 项且不重复。两个服务依序主备，单服务无备用。
- `sources.web.codex.model` 默认 `gpt-6-luna`。
- `sources.github.enabled` 默认 `true`，通过本地只读 `gh api` 搜索，无路由字段。
- 搜索总开关开启时，至少保留一个启用的来源。
- 旧 `search.routing.provider/fallback/fallbackProvider` 转换为网页路由顺序，`search.codex.model` 转换为网页 Codex 模型；旧 provider 接受 `codex` 别名。新 `sources.web` 与任一旧 `routing`／`codex` 同时出现时校验失败；`sources.github` 可与旧网页配置共存。

```json
{
  "pi-web-kits": {
    "search": {
      "enabled": true,
      "maxResults": 5,
      "timeoutMs": 15000,
      "sources": {
        "web": {
          "enabled": true,
          "routing": ["searxng"],
          "codex": { "model": "gpt-6-luna" }
        },
        "github": { "enabled": true }
      }
    }
  }
}
```

## 写入

`updatePiKitsConfig` 读取原始配置，对修改结果重新校验，然后以原子替换方式写入，保留未修改字段，包括未知字段；保留旧键不使其生效。

[配置示例](../../../pi-kits.example.json)和 [JSON Schema](../../../pi-kits.schema.json)位于仓库根目录。
