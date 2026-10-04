# 配置兼容与更新

配置由 `@pi-kits/config` 统一校验及默认化。扩展加载时读取快照，修改后通过 `/reload` 生效。缺失文件或字段使用默认值；格式错误、字段不合法或文件不可读均报错，不静默回退。

## 旧分组兼容

旧 `workspace`、`usage`、`workflow` 分组仍可读取，推荐使用顶层扩展设置：

- 顶层设置覆盖同名旧字段。
- 未指定字段保留旧值，再应用默认值。
- 旧分组的 `enabled: false` 关闭子项，除非子项显式设置顶层 `enabled` 覆盖。
- `web-kits` 的内部配置结构不变。

## 写入

`updatePiKitsConfig` 读取原始配置，对修改结果重新校验，然后以原子替换方式写入，保留未修改字段。`commit.lastModel` 通过此 API 更新。

[配置示例](../../../pi-kits.example.json)和 [JSON Schema](../../../pi-kits.schema.json)位于仓库根目录。
