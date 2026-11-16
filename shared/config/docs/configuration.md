# 配置兼容与更新

配置由 `@pi-kits/config` 统一校验及默认化。扩展加载时读取快照，修改后通过 `/reload` 生效。缺失文件或字段使用默认值；格式错误、字段不合法或文件不可读均报错，不静默回退。

配置的各层对象允许未知字段；未知字段保留在原始配置中，但不进入生效配置。已知字段仍校验类型、范围和枚举，拼错的字段名也作为未知字段忽略。

`web-kits.fetch.github` 仅保留 `enabled`（默认 `true`）；旧 `mode`、`maxRepoSizeMB`、`cloneTimeoutSeconds`、`clonePath` 作为未知字段忽略，包括类型无效的旧值。

`subagent.enabled` 默认为 `true`，终端适配器由扩展按环境自动选择，旧 `subagent.mux` 字段忽略，顶层和旧 `workflow.subagent` 分组均适用。

## 旧分组兼容

旧 `workspace`、`usage`、`workflow` 分组仍可读取，推荐使用顶层扩展设置：

- 顶层设置覆盖同名旧字段。
- 未指定字段保留旧值，再应用默认值。
- 旧分组的 `enabled: false` 关闭子项，除非子项显式设置顶层 `enabled` 覆盖。
- `web-kits.search.routing` 和 `search.codex` 继续兼容；新配置使用 `search.sources.web`，两种网页配置不能混用。

## 搜索能力配置

`web-kits.search` 的公共设置为 `enabled`（默认 `true`）、`maxResults`（默认 5，1–10）和 `timeoutMs`（默认 15000，1000–120000）。

- `sources.web.enabled` 默认 `true`；`sources.web.routing` 默认 `["searxng"]`，可按顺序填写 `searxng`、`codex-alpha-search`，1–2 项且不重复。两个服务依序主备，单服务无备用。
- `sources.web.codex.model` 默认 `gpt-6-luna`。
- `sources.github.enabled` 默认 `true`，通过本地只读 `gh api` 搜索，无路由字段。
- 搜索总开关开启时，至少保留一个启用的来源。
- 旧 `search.routing.provider/fallback/fallbackProvider` 转换为网页路由顺序，`search.codex.model` 转换为网页 Codex 模型；旧 provider 接受 `codex` 别名。新 `sources.web` 与任一旧 `routing`／`codex` 同时出现时校验失败；`sources.github` 可与旧网页配置共存。

```json
{
  "web-kits": {
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

`updatePiKitsConfig` 读取原始配置，对修改结果重新校验，然后以原子替换方式写入，保留未修改字段。旧 `commit`、`stats`、`providerUsage`、`notify` 和 `contextPreview` 设置作为归档扩展的兼容字段保留。

[配置示例](../../../pi-kits.example.json)和 [JSON Schema](../../../pi-kits.schema.json)位于仓库根目录。
